import { describe, it, expect } from "vitest";
import {
  normalizeModel,
  buildUpstreamUrl,
  shouldEnablePromptCacheRouting,
  parseOpenAIUsage,
  mergeProviderHeaders,
} from "../src/proxy/providers/index.js";
import { kimiAdapter } from "../src/proxy/providers/kimi.js";
import type { ProviderConfig } from "../src/types.js";

describe("provider utilities", () => {
  const provider: ProviderConfig = {
    id: "kimi",
    type: "kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn",
    apiKey: "",
    models: ["kimi-k2", "kimi-k2-5"],
    modelMappings: { "my-model": "kimi-k2-5" },
  };

  it("maps a known model alias", () => {
    expect(normalizeModel({ model: "my-model" }, provider)).toBe("kimi-k2-5");
  });

  it("keeps a model listed by the provider", () => {
    expect(normalizeModel({ model: "kimi-k2" }, provider)).toBe("kimi-k2");
  });

  it("falls back to the provider default model", () => {
    expect(normalizeModel({ model: "unknown" }, provider)).toBe("kimi-k2");
    expect(normalizeModel({}, provider)).toBe("kimi-k2");
  });

  it("builds upstream URLs", () => {
    expect(buildUpstreamUrl(provider, "/v1/chat/completions")).toBe("https://api.moonshot.cn/v1/chat/completions");
    expect(buildUpstreamUrl({ ...provider, baseUrl: "https://api.moonshot.cn/" }, "/v1/models")).toBe(
      "https://api.moonshot.cn/v1/models",
    );
  });

  it("decides prompt cache routing", () => {
    expect(shouldEnablePromptCacheRouting(provider)).toBe(true);
    expect(shouldEnablePromptCacheRouting({ ...provider, type: "qianwen" })).toBe(true);
    expect(shouldEnablePromptCacheRouting({ ...provider, promptCacheRouting: "enabled" })).toBe(true);
    expect(shouldEnablePromptCacheRouting({ ...provider, promptCacheRouting: "auto" })).toBe(true);
    expect(shouldEnablePromptCacheRouting({ ...provider, promptCacheRouting: undefined })).toBe(true);
    expect(shouldEnablePromptCacheRouting({ ...provider, promptCacheRouting: "disabled" })).toBe(false);
  });

  it("parses OpenAI usage fields", () => {
    const usage = parseOpenAIUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      },
    });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    });
  });

  it("returns undefined when usage is missing", () => {
    expect(parseOpenAIUsage({})).toBeUndefined();
  });

  it("merges provider headers into request headers", () => {
    const headers = new Headers();
    headers.set("Authorization", "Bearer old");
    mergeProviderHeaders(headers, { ...provider, headers: { "X-Custom": "value", Authorization: "Bearer overridden" } });
    expect(headers.get("X-Custom")).toBe("value");
    expect(headers.get("Authorization")).toBe("Bearer overridden");
  });

  it("leaves headers unchanged when provider has no custom headers", () => {
    const headers = new Headers();
    headers.set("Authorization", "Bearer token");
    mergeProviderHeaders(headers, provider);
    expect(headers.get("Authorization")).toBe("Bearer token");
  });

  it("translates Kimi context-length errors to OpenAI shape", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: "maximum context length 65536 tokens exceeded", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const translated = await kimiAdapter.translateError?.(response, await response.clone().text());
    expect(translated).toBeDefined();
    const body = await translated!.json();
    expect(body.error.type).toBe("context_length_exceeded");
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.error.message).toContain("65536");
  });

  it("returns undefined for Kimi errors that do not match a known pattern", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: "unknown parameter", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const translated = await kimiAdapter.translateError?.(response, await response.clone().text());
    expect(translated).toBeUndefined();
  });
});
