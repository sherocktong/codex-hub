import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJson, writeJson } from "../config.js";
import * as logger from "../logger.js";
import type { ProviderConfig, ProxyConfig } from "../types.js";

const PROXY_CONFIG_DIR = path.join(os.homedir(), ".codex", "codex-hub");
const PROXY_CONFIG_FILE = path.join(PROXY_CONFIG_DIR, "proxy.json");

const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  listenAddress: "127.0.0.1",
  requestTimeout: 120_000,
  maxRetries: 3,
  streamingFirstByteTimeout: 30_000,
  streamingIdleTimeout: 60_000,
  nonStreamingTimeout: 120_000,
};

export function ensureProxyConfigDir(): void {
  if (!fs.existsSync(PROXY_CONFIG_DIR)) {
    fs.mkdirSync(PROXY_CONFIG_DIR, { recursive: true });
  }
}

export function readProxyConfig(): ProxyConfig {
  ensureProxyConfigDir();
  if (!fs.existsSync(PROXY_CONFIG_FILE)) {
    return { ...DEFAULT_PROXY_CONFIG };
  }
  try {
    return { ...DEFAULT_PROXY_CONFIG, ...readJson<ProxyConfig>(PROXY_CONFIG_FILE) };
  } catch (err) {
    logger.error("Failed to read proxy config", err);
    return { ...DEFAULT_PROXY_CONFIG };
  }
}

export function writeProxyConfig(config: ProxyConfig): void {
  ensureProxyConfigDir();
  writeJson(PROXY_CONFIG_FILE, config);
}

const PROVIDERS_FILE = path.join(PROXY_CONFIG_DIR, "providers.json");

export function readProvidersConfig(): Record<string, ProviderConfig> {
  ensureProxyConfigDir();
  if (!fs.existsSync(PROVIDERS_FILE)) {
    return {};
  }
  try {
    return readJson<Record<string, ProviderConfig>>(PROVIDERS_FILE);
  } catch (err) {
    logger.error("Failed to read providers config", err);
    return {};
  }
}

export function writeProvidersConfig(providers: Record<string, ProviderConfig>): void {
  ensureProxyConfigDir();
  writeJson(PROVIDERS_FILE, providers);
}

export function getProviderConfig(id: string): ProviderConfig | undefined {
  const providers = readProvidersConfig();
  return providers[id];
}

export function getDefaultProviderPresets(): Record<string, ProviderConfig> {
  return {
    kimi: {
      id: "kimi",
      type: "kimi",
      name: "Kimi",
      baseUrl: "https://api.kimi.com/coding",
      apiKey: "",
      models: ["kimi-k2-5-coding"],
      promptCacheRouting: "enabled",
      responsesToChatCompletions: true,
    },
    qianwen: {
      id: "qianwen",
      type: "qianwen",
      name: "Qianwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "",
      models: ["qwen-max"],
      promptCacheRouting: "enabled",
      responsesToChatCompletions: true,
    },
  };
}
