import type { ProviderConfig, ProviderAdapter, RequestContext, TokenUsage } from "../types.js";
import { kimiAdapter } from "./kimi.js";
import { qianwenAdapter } from "./qianwen.js";

export const ADAPTERS: Record<ProviderConfig["type"], ProviderAdapter> = {
  kimi: kimiAdapter,
  qianwen: qianwenAdapter,
};

export function getAdapter(provider: ProviderConfig): ProviderAdapter {
  const adapter = ADAPTERS[provider.type];
  if (!adapter) {
    throw new Error(`No adapter registered for provider type '${provider.type}'`);
  }
  return adapter;
}

export function parseOpenAIUsage(data: Record<string, unknown>): TokenUsage | undefined {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;

  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;

  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  if (promptDetails) {
    if (typeof promptDetails.cached_tokens === "number") {
      cacheReadTokens = promptDetails.cached_tokens;
    }
    if (typeof promptDetails.cache_write_tokens === "number") {
      cacheCreationTokens = promptDetails.cache_write_tokens;
    }
  }

  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  if (inputDetails) {
    if (typeof inputDetails.cached_tokens === "number") {
      cacheReadTokens = inputDetails.cached_tokens;
    }
    if (typeof inputDetails.cache_write_tokens === "number") {
      cacheCreationTokens = inputDetails.cache_write_tokens;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

export function normalizeModel(
  body: Record<string, unknown>,
  provider: ProviderConfig,
): string {
  const requestedModel = typeof body.model === "string" ? body.model : "";
  if (provider.modelMappings?.[requestedModel]) {
    return provider.modelMappings[requestedModel];
  }
  if (provider.models.includes(requestedModel)) {
    return requestedModel;
  }
  return provider.models[0] || requestedModel;
}

export function buildUpstreamUrl(provider: ProviderConfig, path: string): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // Kimi/Qianwen OpenAI-compatible endpoints expect /v1/...
  return `${base}${normalizedPath}`;
}

export function shouldEnablePromptCacheRouting(provider: ProviderConfig): boolean {
  if (provider.promptCacheRouting === "disabled") {
    return false;
  }
  // "enabled", "auto", and undefined all default to on for backward compatibility.
  return true;
}
