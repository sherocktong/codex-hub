import type { TokenUsage } from "../types.js";

export function parseCacheTokens(response: Record<string, unknown>): TokenUsage | undefined {
  const usage = response.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;

  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;

  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  if (promptDetails) {
    if (typeof promptDetails.cached_tokens === "number") cacheReadTokens = promptDetails.cached_tokens;
    if (typeof promptDetails.cache_write_tokens === "number") cacheCreationTokens = promptDetails.cache_write_tokens;
  }

  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  if (inputDetails) {
    if (typeof inputDetails.cached_tokens === "number") cacheReadTokens = inputDetails.cached_tokens;
    if (typeof inputDetails.cache_write_tokens === "number") cacheCreationTokens = inputDetails.cache_write_tokens;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
