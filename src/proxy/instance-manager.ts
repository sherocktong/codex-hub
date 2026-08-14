import type { Profile, ProfilesData } from "../types.js";
import { PROFILES_FILE, ensureProfilesFile, readJson, writeJson } from "../config.js";
import { readProxyConfig, getProviderConfig, getDefaultProviderPresets, writeProvidersConfig, readProvidersConfig } from "./config.js";
import { startProxyServer, findAvailablePort, type ProxyServer } from "./server.js";
import * as logger from "../logger.js";
import * as proxyRegistry from "./proxy-registry.js";
import { startProxyDaemon } from "./proxy-process.js";
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
  const data = readJson<ProfilesData>(PROFILES_FILE);
  const profile = data.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found.`);
  }

  const config = buildProxyInstanceConfig(profileName, profile);
  ensureProviderPresetsExist();

  const acquisition = await proxyRegistry.acquireProxy(
    profileName,
    config.listenAddress,
    async () => {
      // Start the proxy in a detached daemon so it outlives this consumer.
      const daemon = await startProxyDaemon(profileName);
      localDaemons.set(profileName, { pid: daemon.pid, kill: daemon.kill });
      return { baseUrl: daemon.baseUrl, port: daemon.port };
    },
  );

  if (acquisition.isOwner) {
    // The proxy was started by this process as a daemon. No local server object is needed,
    // but we keep a placeholder so consumers can read baseUrl/port.
    config.port = acquisition.port;
  } else {
    config.port = acquisition.port;
    // Persist the reused port to the profile so future offline commands display it.
    if (profile.proxyPort !== acquisition.port) {
      profile.proxyPort = acquisition.port;
      writeJson(PROFILES_FILE, data);
      logger.debug(`profile proxy port persisted: ${profileName} -> ${acquisition.port}`);
    }
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
    // Quick check: if the port is free, reuse it. We bind and immediately release.
    try {
      await new Promise<void>((resolve, reject) => {
        const tester = require("node:net")
          .createServer()
          .once("error", () => reject(new Error("in use")))
          .once("listening", () => {
            tester.close(() => resolve());
          })
          .listen(existingPort, proxyConfig.listenAddress);
      });
      return existingPort;
    } catch {
      // fall through to allocate a new port
    }
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
