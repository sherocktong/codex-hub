export type ProviderType = "kimi" | "qianwen";

export type PromptCacheRoutingMode = "auto" | "enabled" | "disabled";

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelMappings?: Record<string, string>;
  promptCacheRouting?: PromptCacheRoutingMode;
  responsesToChatCompletions?: boolean;
  headers?: Record<string, string>;
}

export interface Profile {
  model?: string;
  models?: string[];
  token?: string;
  url?: string;
  provider?: ProviderType;
  proxyPort?: number;
}

export interface ProfilesData {
  profiles: Record<string, Profile>;
  default?: string;
  _codex_hub_seq?: number;
}

export interface ProxyConfig {
  listenAddress: string;
  requestTimeout: number;
  maxRetries: number;
  streamingFirstByteTimeout: number;
  streamingIdleTimeout: number;
  nonStreamingTimeout: number;
}

export interface ProxyStatus {
  running: boolean;
  address: string;
  port: number;
  uptimeSeconds: number;
  activeTargets: ActiveTarget[];
}

export interface ActiveTarget {
  appType: string;
  providerId: string;
  providerName: string;
}

export interface HookEntry {
  type: string;
  command: string;
  _seq: number;
  async?: boolean;
  event?: string;
  matcher?: string;
}

export interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: string; command: string; _seq: number; async?: boolean }>;
}

export interface SettingsData {
  hooks?: Record<string, HookGroup[]>;
  _codex_hub_disabled?: HookEntry[];
  _codex_hub_seq?: number;
  _codex_hub_logLevel?: string;
  [key: string]: unknown;
}

export interface FlatHook {
  seq: number;
  active: boolean;
  event: string;
  matcher: string;
  command: string;
  gi: number;
  hi: number;
  di: number;
}

export interface SessionInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  startedAt: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface FailoverQueueItem {
  providerId: string;
  providerName: string;
}

export type CircuitState = "closed" | "open" | "half-open";
