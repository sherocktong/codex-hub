import { describe, it, expect } from "vitest";
import { injectCacheRouting, countExistingCacheControls } from "../src/proxy/cache-injector.js";
import type { RequestContext } from "../src/proxy/types.js";

function makeCtx(providerType: "kimi" | "qianwen", path = "/v1/responses", sessionId?: string): RequestContext {
  return {
    profileName: "dev",
    provider: {
      id: providerType,
      type: providerType,
      name: providerType === "qianwen" ? "Qianwen" : "Kimi",
      baseUrl: "https://example.com",
      apiKey: "test",
      models: [providerType === "qianwen" ? "qwen-max" : "kimi-k2"],
      promptCacheRouting: "enabled",
    },
    path,
    sessionId,
    request: new Request("http://localhost"),
    body: {},
    method: "POST",
    headers: new Headers(),
    startTime: Date.now(),
    attempt: 0,
    state: {},
  };
}

describe("injectCacheRouting", () => {
  describe("Kimi", () => {
    it("injects prompt_cache_key for /v1/responses", () => {
      const body: Record<string, unknown> = {};
      injectCacheRouting(body, makeCtx("kimi", "/v1/responses", "session-123"));
      expect(body.prompt_cache_key).toBe("session-123");
    });

    it("does not inject prompt_cache_key for /v1/chat/completions", () => {
      const body: Record<string, unknown> = {};
      injectCacheRouting(body, makeCtx("kimi", "/v1/chat/completions", "session-123"));
      expect(body.prompt_cache_key).toBeUndefined();
    });
  });

  describe("Qwen", () => {
    it("marks the system message string content", () => {
      const body = {
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "hello" },
        ],
      };
      injectCacheRouting(body, makeCtx("qianwen"));
      expect(body.messages).toEqual([
        {
          role: "system",
          content: [
            { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
          ],
        },
        { role: "user", content: "hello" },
      ]);
      expect(body.prompt_cache_key).toBeUndefined();
    });

    it("marks the last text block of array content", () => {
      const body = {
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "You are a helpful assistant." },
              { type: "text", text: "Follow the instructions carefully." },
            ],
          },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
      };
      injectCacheRouting(body, makeCtx("qianwen"));
      const systemContent = body.messages[0].content as Array<Record<string, unknown>>;
      expect(systemContent[1].cache_control).toEqual({ type: "ephemeral" });
      expect(systemContent[0].cache_control).toBeUndefined();
    });

    it("marks the prefix boundary before the final user message", () => {
      const body = {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "question 1" },
          { role: "assistant", content: "answer 1" },
          { role: "user", content: "question 2" },
        ],
      };
      injectCacheRouting(body, makeCtx("qianwen"));
      const assistant = body.messages[2];
      expect(assistant.content).toEqual([
        { type: "text", text: "answer 1", cache_control: { type: "ephemeral" } },
      ]);
    });

    it("marks the only user message when there is no system message", () => {
      const body = {
        messages: [{ role: "user", content: "hello" }],
      };
      injectCacheRouting(body, makeCtx("qianwen"));
      expect(body.messages[0].content).toEqual([
        { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
      ]);
    });

    it("preserves existing user-supplied markers and counts them toward the limit", () => {
      const body = {
        messages: [
          { role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] },
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
          { role: "assistant", content: "a2" },
          { role: "user", content: "u3" },
          { role: "assistant", content: "a3" },
          { role: "user", content: "u4" },
        ],
      };
      injectCacheRouting(body, makeCtx("qianwen"));
      const markers = countExistingCacheControls(body);
      expect(markers).toBeLessThanOrEqual(4);
      // Existing system marker is preserved; assistant before the last user gets a marker.
      expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("does not double-mark a message that already has a marker", () => {
      const body = {
        messages: [
          { role: "system", content: "sys" },
          {
            role: "user",
            content: [{ type: "text", text: "u1", cache_control: { type: "ephemeral" } }],
          },
        ],
      };
      injectCacheRouting(body, makeCtx("qianwen"));
      expect(countExistingCacheControls(body)).toBe(2);
      expect(body.messages[1].content).toEqual([
        { type: "text", text: "u1", cache_control: { type: "ephemeral" } },
      ]);
    });

    it("does not mutate the original message objects", () => {
      const messages = [{ role: "system", content: "sys" }];
      const body = { messages };
      injectCacheRouting(body, makeCtx("qianwen"));
      expect(messages[0].content).toBe("sys");
      expect(body.messages[0].content).not.toBe("sys");
    });

    it("is a no-op when messages are missing or empty", () => {
      const body1: Record<string, unknown> = {};
      injectCacheRouting(body1, makeCtx("qianwen"));
      expect(body1.messages).toBeUndefined();

      const body2 = { messages: [] };
      injectCacheRouting(body2, makeCtx("qianwen"));
      expect(body2.messages).toEqual([]);
    });
  });
});

describe("countExistingCacheControls", () => {
  it("counts message-level and block-level markers", () => {
    const body = {
      messages: [
        { role: "system", content: "sys", cache_control: { type: "ephemeral" } },
        {
          role: "user",
          content: [
            { type: "text", text: "u1", cache_control: { type: "ephemeral" } },
            { type: "text", text: "u2" },
          ],
        },
      ],
    };
    expect(countExistingCacheControls(body)).toBe(2);
  });

  it("returns 0 when there are no markers", () => {
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
      ],
    };
    expect(countExistingCacheControls(body)).toBe(0);
  });
});
