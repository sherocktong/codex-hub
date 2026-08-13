import type { RequestContext } from "./types.js";

export function selectCacheKeySource(ctx: RequestContext): string | undefined {
  // Prefer a stable session id so repeated calls in the same session hit the cache.
  if (ctx.sessionId) return ctx.sessionId;
  // Fall back to a hash of the profile + provider + model.
  return `${ctx.profileName}:${ctx.provider.id}:${ctx.body.model ?? "default"}`;
}

export function injectPromptCacheKey(
  body: Record<string, unknown>,
  ctx: RequestContext,
): void {
  const key = selectCacheKeySource(ctx);
  if (!key) return;

  // OpenAI Responses API uses prompt_cache_key for cache routing.
  // OpenAI Chat Completions does not; it relies on prompt_tokens_details.
  if (ctx.path === "/v1/responses") {
    body.prompt_cache_key = key;
  }
}
