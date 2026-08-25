import { describe, it, expect } from "vitest";
import { extractStreamUsage } from "../src/proxy/usage.js";

describe("extractStreamUsage", () => {
  it("parses Codex response.completed usage", () => {
    const event = {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    };
    expect(extractStreamUsage(event)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 0,
    });
  });

  it("parses cache write tokens from input_tokens_details", () => {
    const event = {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
        },
      },
    };
    expect(extractStreamUsage(event)).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 5,
      cacheCreationTokens: 3,
    });
  });

  it("parses OpenAI chat completion stream usage chunks", () => {
    const event = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 },
      },
    };
    expect(extractStreamUsage(event)).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 4,
      cacheCreationTokens: 1,
    });
  });

  it("prefers the last non-zero usage", () => {
    const first = {
      type: "response.completed",
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    };
    expect(extractStreamUsage(first)).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const second = {
      type: "response.completed",
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    };
    expect(extractStreamUsage(second)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("returns undefined when no usage is present", () => {
    expect(extractStreamUsage({ type: "response.output_text.delta", delta: "hi" })).toBeUndefined();
  });

  it("returns undefined for zero usage", () => {
    const event = {
      type: "response.completed",
      response: { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    };
    expect(extractStreamUsage(event)).toBeUndefined();
  });
});
