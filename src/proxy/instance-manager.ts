import type { Profile, ProfilesData } from "../types.js";
import { PROFILES_FILE, ensureProfilesFile, readJson, writeJson } from "../config.js";
import { readProxyConfig, getProviderConfig, getDefaultProviderPresets, writeProvidersConfig, readProvidersConfig } from "./config.js";
import { startProxyServer, type ProxyServer } from "./server.js";
import { createRequestHandler } from "./handlers.js";
import * as logger from "../logger.js";
import type { ProviderConfig, ProxyInstanceConfig } from "./types.js";

export interface RunningProxy {
  profileName: string;
  server: ProxyServer;
  config: ProxyInstanceConfig;
  startedAt: Date;
}

const runningProxies = new Map<string, RunningProxy>();

export function listRunningProxies(): RunningProxy[] {
  return Array.from(runningProxies.values());
}

export function getRunningProxy(profileName: string): RunningProxy | undefined {
  return runningProxies.get(profileName);
}

export async function startProfileProxy(profileName: string): Promise<RunningProxy> {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  const profile = data.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found.`);
  }

  const existing = runningProxies.get(profileName);
  if (existing) {
    logger.debug(`Proxy for profile '${profileName}' already running on ${existing.server.baseUrl}`);
    return existing;
  }

  const config = buildProxyInstanceConfig(profileName, profile);
  ensureProviderPresetsExist();

  const requestHandler = createRequestHandler(config);
  const server = await startProxyServer(config.port, config.listenAddress, requestHandler);

  // Update config with the actual bound port if port was 0 (auto-allocated)
  config.port = server.port;

  // Persist the allocated port to the profile so future commands can display it even when the proxy is not running.
  if (profile.proxyPort !== server.port) {
    profile.proxyPort = server.port;
    writeJson(PROFILES_FILE, data);
    logger.debug(`profile proxy port persisted: ${profileName} -> ${server.port}`);
  }

  const running: RunningProxy = {
    profileName,
    server,
    config,
    startedAt: new Date(),
  };
  runningProxies.set(profileName, running);
  logger.info(`Started proxy for profile '${profileName}' on ${server.baseUrl}`);
  return running;
}

export async function stopProfileProxy(profileName: string): Promise<void> {
  const running = runningProxies.get(profileName);
  if (!running) {
    throw new Error(`Proxy for profile '${profileName}' is not running.`);
  }
  await running.server.stop();
  runningProxies.delete(profileName);
  logger.info(`Stopped proxy for profile '${profileName}'`);
}

export async function stopAllProxies(): Promise<void> {
  await Promise.all(Array.from(runningProxies.keys()).map(stopProfileProxy));
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
      `Profile '${profileName}' has no valid provider. Set a provider on the profile with 'codex-hub profile add -p <provider>'.`,
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
