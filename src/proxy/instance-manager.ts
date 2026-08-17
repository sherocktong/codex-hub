import type { Profile, ProfilesData } from "../types.js";
import { PROFILES_FILE, ensureProfilesFile, readJson, writeJson } from "../config.js";
import { readProxyConfig, getProviderConfig, getDefaultProviderPresets, writeProvidersConfig, readProvidersConfig } from "./config.js";
import { startProxyServer, findAvailablePort, type ProxyServer } from "./server.js";
import * as logger from "../logger.js";
import * as proxyRegistry from "./proxy-registry.js";
import { startProxyDaemon, spawnManagedProxyDaemon, killProxyProcess } from "./proxy-process.js";
import type { ProviderConfig, ProxyInstanceConfig } from "./types.js";

export interface RunningProxy {
  profileName: string;
  server: ProxyServer;
  config: ProxyInstanceConfig;
  startedAt: Date;
}

const localServers = new Map<string, ProxyServer>();
const localDaemons = new Map<string, { pid: number; kill: () => Promise<void> }>();

export function listRunningProxies(): RunningProxy[] {
  const registry = proxyRegistry.cleanDeadEntries(proxyRegistry.readRegistry());
  return Object.values(registry).map((entry) => ({
    profileName: entry.profileName,
    config: buildProxyInstanceConfig(entry.profileName, readJson<ProfilesData>(PROFILES_FILE).profiles[entry.profileName]),
    startedAt: new Date(entry.startedAt),
    server: {
      baseUrl: `http://${entry.listenAddress}:${entry.port}`,
      port: entry.port,
      stop: async () => { /* no-op: stopping is registry-managed */ },
    },
  }));
}

export function getRunningProxy(profileName: string): RunningProxy | undefined {
  const entry = proxyRegistry.getRegistryEntry(profileName);
  if (!entry) return undefined;
  return {
    profileName: entry.profileName,
    config: buildProxyInstanceConfig(profileName, readJson<ProfilesData>(PROFILES_FILE).profiles[profileName]),
    startedAt: new Date(entry.startedAt),
    server: {
      baseUrl: `http://${entry.listenAddress}:${entry.port}`,
      port: entry.port,
      stop: async () => { /* no-op */ },
    },
  };
}

export interface AcquiredProxy {
  running: RunningProxy;
  release: () => void;
}

export async function acquireProfileProxy(profileName: string): Promise<AcquiredProxy> {
  ensureProfilesFile();
  ensureProviderPresetsExist();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  const profile = data.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found.`);
  }

  const config = buildProxyInstanceConfig(profileName, profile);

  const acquisition = await proxyRegistry.acquireProxy(
    profileName,
    config.listenAddress,
    async () => {
      // Start the proxy in a detached daemon so it outlives this consumer.
      const daemon = await startProxyDaemon(profileName);
      localDaemons.set(profileName, { pid: daemon.pid, kill: daemon.kill });
      return { baseUrl: daemon.baseUrl, port: daemon.port, proxyPid: daemon.pid };
    },
  );

  if (acquisition.isOwner) {
    // The proxy was started by this process as a daemon. No local server object is needed,
    // but we keep a placeholder so consumers can read baseUrl/port.
    config.port = acquisition.port;
  } else {
    config.port = acquisition.port;
    // The port is owned by the daemon and sourced from profiles.json; do not persist it back
    // here to avoid floating ports when multiple consumers race to update the file.
  }

  const server: ProxyServer = localServers.get(profileName) || {
    baseUrl: acquisition.baseUrl,
    port: acquisition.port,
    stop: async () => {
      const daemon = localDaemons.get(profileName);
      if (daemon) {
        await daemon.kill();
        localDaemons.delete(profileName);
      }
    },
  };

  const running: RunningProxy = {
    profileName,
    server,
    config,
    startedAt: new Date(),
  };

  return {
    running,
    release: () => {
      proxyRegistry.releaseProxy(profileName, () => server.stop());
    },
  };
}

export function reserveProxyPort(profileName: string): number {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  const profile = data.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found.`);
  }

  const existingPort = profile.proxyPort;
  if (existingPort) {
    return existingPort;
  }

  throw new Error(
    `Profile '${profileName}' has no reserved proxy port. Run 'codx run' first to allocate one.`,
  );
}

export async function reserveProxyPortAsync(profileName: string): Promise<number> {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  const profile = data.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found.`);
  }

  const proxyConfig = readProxyConfig();
  const existingPort = profile.proxyPort;

  if (existingPort) {
    // The profile already has a reserved port. Reuse it without checking
    // availability so restarts keep the same port even if the old process is
    // still releasing its socket. The daemon will fail to bind if the port is
    // genuinely unavailable, which is the desired behavior for a reserved port.
    return existingPort;
  }

  const port = await findAvailablePort(proxyConfig.listenAddress);
  profile.proxyPort = port;
  writeJson(PROFILES_FILE, data);
  logger.debug(`reserved proxy port for profile '${profileName}': ${port}`);
  return port;
}

export async function stopProfileProxy(profileName: string): Promise<void> {
  proxyRegistry.releaseProxy(profileName, async () => {
    const daemon = localDaemons.get(profileName);
    if (daemon) {
      await daemon.kill();
      localDaemons.delete(profileName);
    }
    const server = localServers.get(profileName);
    if (server) {
      await server.stop();
      localServers.delete(profileName);
    }
  });
}

export async function stopAllProxies(): Promise<void> {
  proxyRegistry.stopAllOwnedProxies(async (entry) => {
    const daemon = localDaemons.get(entry.profileName);
    if (daemon) {
      await daemon.kill();
      localDaemons.delete(entry.profileName);
    }
    const server = localServers.get(entry.profileName);
    if (server) {
      await server.stop();
      localServers.delete(entry.profileName);
    }
  });
}

export interface ManagedProxyStatus {
  profileName: string;
  pid: number;
  port: number;
  listenAddress: string;
  baseUrl: string;
  healthy: boolean;
  startedAt: Date;
  consumerCount: number;
}

export interface ManagedProxyStartResult {
  status: ManagedProxyStatus;
  alreadyRunning: boolean;
}

export async function startManagedProfileProxy(profileName: string): Promise<ManagedProxyStartResult> {
  ensureProfilesFile();
  ensureProviderPresetsExist();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  const profile = data.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found.`);
  }

  const config = buildProxyInstanceConfig(profileName, profile);

  proxyRegistry.acquireLock();
  try {
    let registry = proxyRegistry.readRegistry();
    registry = proxyRegistry.cleanDeadEntries(registry);

    const existing = registry[profileName];
    if (existing) {
      const baseUrl = `http://${existing.listenAddress}:${existing.port}`;
      const healthy = await proxyRegistry.checkProxyHealth(baseUrl);
      if (healthy) {
        return {
          status: {
            profileName,
            pid: existing.proxyPid,
            port: existing.port,
            listenAddress: existing.listenAddress,
            baseUrl,
            healthy: true,
            startedAt: new Date(existing.startedAt),
            consumerCount: existing.consumers.length,
          },
          alreadyRunning: true,
        };
      }
      delete registry[profileName];
    }

    const port = await reserveProxyPortAsync(profileName);
    config.port = port;

    // Fire-and-forget: spawn the daemon and pre-register it so the daemon's
    // own liveness watcher sees a live consumer and stays alive. Do not wait
    // for PROXY_READY or a health check; the CLI command must exit immediately.
    const { pid: daemonPid } = spawnManagedProxyDaemon(profileName, port);

    const entry: proxyRegistry.ProxyRegistryEntry = {
      profileName,
      listenAddress: config.listenAddress,
      port,
      proxyPid: daemonPid,
      consumers: [daemonPid],
      startedAt: Date.now(),
    };
    registry[profileName] = entry;
    proxyRegistry.writeRegistry(registry);

    return {
      status: {
        profileName,
        pid: daemonPid,
        port,
        listenAddress: config.listenAddress,
        baseUrl: `http://${config.listenAddress}:${port}`,
        healthy: true,
        startedAt: new Date(entry.startedAt),
        consumerCount: 1,
      },
      alreadyRunning: false,
    };
  } finally {
    proxyRegistry.releaseLock();
  }
}

export async function stopManagedProfileProxy(profileName: string): Promise<boolean> {
  proxyRegistry.acquireLock();
  try {
    let registry = proxyRegistry.readRegistry();
    registry = proxyRegistry.cleanDeadEntries(registry);

    const entry = registry[profileName];
    if (!entry) {
      return false;
    }

    delete registry[profileName];
    proxyRegistry.writeRegistry(registry);

    await killProxyProcess(entry.proxyPid);
    return true;
  } finally {
    proxyRegistry.releaseLock();
  }
}

export async function stopAllManagedProxies(): Promise<void> {
  const entries = proxyRegistry.listRegistryEntries();
  for (const entry of entries) {
    await stopManagedProfileProxy(entry.profileName);
  }
}

export async function restartManagedProfileProxy(profileName: string): Promise<ManagedProxyStartResult> {
  await stopManagedProfileProxy(profileName);
  return startManagedProfileProxy(profileName);
}

export async function getManagedProxyStatus(profileName: string): Promise<ManagedProxyStatus | undefined> {
  const entry = proxyRegistry.getRegistryEntry(profileName);
  if (!entry) return undefined;

  const baseUrl = `http://${entry.listenAddress}:${entry.port}`;
  const healthy = await proxyRegistry.checkProxyHealth(baseUrl);
  return {
    profileName,
    pid: entry.proxyPid,
    port: entry.port,
    listenAddress: entry.listenAddress,
    baseUrl,
    healthy,
    startedAt: new Date(entry.startedAt),
    consumerCount: entry.consumers.length,
  };
}

export async function listManagedProxyStatuses(): Promise<ManagedProxyStatus[]> {
  const entries = proxyRegistry.listRegistryEntries();
  const statuses: ManagedProxyStatus[] = [];
  for (const entry of entries) {
    const baseUrl = `http://${entry.listenAddress}:${entry.port}`;
    const healthy = await proxyRegistry.checkProxyHealth(baseUrl);
    statuses.push({
      profileName: entry.profileName,
      pid: entry.proxyPid,
      port: entry.port,
      listenAddress: entry.listenAddress,
      baseUrl,
      healthy,
      startedAt: new Date(entry.startedAt),
      consumerCount: entry.consumers.length,
    });
  }
  return statuses;
}

export function buildProxyInstanceConfig(profileName: string, profile: Profile): ProxyInstanceConfig {
  const proxyConfig = readProxyConfig();
  const providerIds = profile.provider ? [profile.provider] : [];

  const profileModels = resolveProviderModels(profile);
  const providers = providerIds
    .map((id) => getProviderConfig(id))
    .filter((p): p is ProviderConfig => !!p)
    .map((p) => ({
      ...p,
      baseUrl: profile.url || p.baseUrl,
      apiKey: profile.token || p.apiKey,
      models: profileModels.length > 0 ? profileModels : p.models,
    }));

  if (providers.length === 0) {
    throw new Error(
      `Profile '${profileName}' has no valid provider. Set a provider on the profile with 'codx profile add -p <provider>'.`,
    );
  }

  return {
    profileName,
    port: profile.proxyPort ?? 0,
    listenAddress: proxyConfig.listenAddress,
    providers: [providers[0]],
    requestTimeout: proxyConfig.requestTimeout,
    maxRetries: proxyConfig.maxRetries,
    streamingFirstByteTimeout: proxyConfig.streamingFirstByteTimeout,
    streamingIdleTimeout: proxyConfig.streamingIdleTimeout,
    nonStreamingTimeout: proxyConfig.nonStreamingTimeout,
  };
}

export function ensureProviderPresetsExist(): void {
  const presets = getDefaultProviderPresets();
  const existing = readProvidersConfig();
  let changed = false;

  // Remove presets that no longer exist in defaults.
  for (const id of Object.keys(existing)) {
    if (!presets[id]) {
      delete existing[id];
      changed = true;
    }
  }

  // Add or update current presets.
  for (const [id, preset] of Object.entries(presets)) {
    if (JSON.stringify(existing[id]) !== JSON.stringify(preset)) {
      existing[id] = preset;
      changed = true;
    }
  }

  if (changed) {
    writeProvidersConfig(existing);
  }
}

export function resolveProviderModels(profile: Profile): string[] {
  return profile.models?.length ? profile.models : profile.model ? [profile.model] : [];
}
