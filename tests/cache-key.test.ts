import { describe, it, expect } from "vitest";
import { injectPromptCacheKey, selectCacheKeySource } from "../src/proxy/cache-key.js";
import type { RequestContext } from "../src/proxy/types.js";

describe("prompt cache key routing", () => {
  const baseCtx = {
    profileName: "dev",
    provider: { id: "kimi", type: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn", apiKey: "", models: ["kimi-k2"] } as const,
    path: "/v1/responses",
    sessionId: "session-123",
  } as unknown as RequestContext;

  it("selects session id as cache key source when available", () => {
    expect(selectCacheKeySource(baseCtx)).toBe("session-123");
  });

  it("falls back to a profile/provider/model derived key", () => {
    const ctx = { ...baseCtx, sessionId: undefined, body: { model: "test-model" } } as RequestContext;
    expect(selectCacheKeySource(ctx)).toBe("dev:kimi:test-model");
  });

  it("injects prompt_cache_key for /v1/responses", () => {
    const body: Record<string, unknown> = {};
    injectPromptCacheKey(body, baseCtx);
    expect(body.prompt_cache_key).toBe("session-123");
  });

  it("does not inject prompt_cache_key for chat completions", () => {
    const body: Record<string, unknown> = {};
    const ctx = { ...baseCtx, path: "/v1/chat/completions" } as RequestContext;
    injectPromptCacheKey(body, ctx);
    expect(body.prompt_cache_key).toBeUndefined();
  });
});
