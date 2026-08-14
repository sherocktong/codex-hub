import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJson, writeJson } from "../config.js";
import * as logger from "../logger.js";
import type { ProviderConfig, ProxyConfig } from "../types.js";

function getProxyConfigDir(): string {
  return process.env.CODX_PROXY_CONFIG_DIR || path.join(os.homedir(), ".codex", "codx");
}

function getProxyConfigFile(): string {
  return path.join(getProxyConfigDir(), "proxy.json");
}

function getProvidersFile(): string {
  return path.join(getProxyConfigDir(), "providers.json");
}

const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  listenAddress: "127.0.0.1",
  requestTimeout: 120_000,
  maxRetries: 3,
  streamingFirstByteTimeout: 30_000,
  streamingIdleTimeout: 60_000,
  nonStreamingTimeout: 120_000,
};

export function ensureProxyConfigDir(): void {
  const dir = getProxyConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readProxyConfig(): ProxyConfig {
  const filePath = getProxyConfigFile();
  ensureProxyConfigDir();
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_PROXY_CONFIG };
  }
  try {
    return { ...DEFAULT_PROXY_CONFIG, ...readJson<ProxyConfig>(filePath) };
  } catch (err) {
    logger.error("Failed to read proxy config", err);
    return { ...DEFAULT_PROXY_CONFIG };
  }
}

export function writeProxyConfig(config: ProxyConfig): void {
  ensureProxyConfigDir();
  writeJson(getProxyConfigFile(), config);
}

export function readProvidersConfig(): Record<string, ProviderConfig> {
  const filePath = getProvidersFile();
  ensureProxyConfigDir();
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return readJson<Record<string, ProviderConfig>>(filePath);
  } catch (err) {
    logger.error("Failed to read providers config", err);
    return {};
  }
}

export function writeProvidersConfig(providers: Record<string, ProviderConfig>): void {
  ensureProxyConfigDir();
  writeJson(getProvidersFile(), providers);
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
      // Qianwen's OpenAI-compatible endpoint supports Anthropic-style
      // cache_control markers for explicit context caching on supported models.
      promptCacheRouting: "enabled",
      responsesToChatCompletions: true,
    },
  };
}
