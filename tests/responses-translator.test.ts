import { describe, it, expect } from "vitest";
import {
  translateResponsesRequestToChat,
  translateChatResponseToResponses,
  translateChatStreamChunkToResponses,
  createResponsesDoneChunk,
} from "../src/proxy/responses-translator.js";
import type { ProviderConfig } from "../src/types.js";

const provider: ProviderConfig = {
  id: "kimi",
  type: "kimi",
  name: "Kimi",
  baseUrl: "https://api.kimi.com/coding",
  apiKey: "",
  models: ["kimi-k2-5-coding"],
  responsesToChatCompletions: true,
};

describe("responses-to-chat-completions translator", () => {
  it("translates a simple text Responses request", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      },
      provider,
    );
    expect(result.upstreamPath).toBe("/v1/chat/completions");
    expect(result.upstreamBody.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect(result.upstreamBody.model).toBe("kimi-k2-5-coding");
  });

  it("translates a chat completion response", () => {
    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "kimi-k2-5-coding",
        choices: [{ message: { role: "assistant", content: "Hi there" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      { model: "kimi-k2.7" },
    );
    expect(translated.object).toBe("response");
    expect(translated.output).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hi there" }],
      },
    ]);
    expect(translated.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("translates a streaming chat completion chunk", () => {
    const ctx = { state: {} };
    const translated = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-123",
        created: 1234567890,
        choices: [{ delta: { role: "assistant", content: "Hi" } }],
      },
      { model: "kimi-k2.7" },
    );
    expect(translated).toBeDefined();
    expect(Array.isArray(translated)).toBe(true);
    const events = translated as Record<string, unknown>[];
    expect(events[0].type).toBe("response.created");
    expect(events[1].type).toBe("response.output_item.added");
    expect(events[2].type).toBe("response.output_text.delta");
    expect(events[2]).toMatchObject({ item_id: "chatcmpl-123_item", output_index: 0, content_index: 0, delta: "Hi" });
    expect(ctx.state.accumulatedText).toBe("Hi");
  });

  it("emits response.completed on the usage chunk", () => {
    const ctx = { state: { accumulatedText: "Hello world" } };
    const translated = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-123",
        created: 1234567890,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      { model: "kimi-k2.7" },
    );
    expect(translated).toBeDefined();
    const events = translated as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("response.completed");
    expect((events[0].response as Record<string, unknown>).status).toBe("completed");
    expect((events[0].response as Record<string, unknown>).output).toEqual([]);
  });

  it("translates streaming tool call chunks to function_call events", () => {
    const ctx = { state: {} };
    const originalBody = { model: "kimi-k2.7" };

    const firstChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-tool",
        created: 1234567890,
        choices: [{ delta: { role: "assistant" } }],
      },
      originalBody,
    );
    expect(firstChunk?.[0].type).toBe("response.created");

    const secondChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-tool",
        created: 1234567890,
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "calculator", arguments: "" },
                },
              ],
            },
          },
        ],
      },
      originalBody,
    );
    expect(secondChunk?.some((e) => e.type === "response.output_item.added")).toBe(true);
    const added = secondChunk?.find((e) => e.type === "response.output_item.added") as Record<string, unknown>;
    expect((added.item as Record<string, unknown>).type).toBe("function_call");
    expect((added.item as Record<string, unknown>).name).toBe("calculator");

    const thirdChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-tool",
        created: 1234567890,
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"x\": 1}" } }] } }],
      },
      originalBody,
    );
    expect(thirdChunk?.some((e) => e.type === "response.function_call_arguments.delta")).toBe(true);

    const finalChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-tool",
        created: 1234567890,
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      },
      originalBody,
    );
    expect(finalChunk?.some((e) => e.type === "response.function_call_arguments.done")).toBe(true);
    expect(finalChunk?.some((e) => e.type === "response.output_item.done")).toBe(true);
    expect(finalChunk?.some((e) => e.type === "response.completed")).toBe(true);
  });

  it("includes prompt cache details in streaming usage", () => {
    const ctx = { state: { textOutputItemAdded: true, accumulatedText: "Hello" } };
    const translated = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-cache",
        created: 1234567890,
        choices: [{ delta: {}, finish_reason: "stop", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 5 } }],
      },
      { model: "kimi-k2.7" },
    );
    const completed = translated.find((e) => e.type === "response.completed") as Record<string, unknown> | undefined;
    expect(completed).toBeDefined();
    const usage = (completed?.response as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
    expect(usage?.input_tokens).toBe(10);
    expect(usage?.output_tokens).toBe(2);
    expect(usage?.total_tokens).toBe(12);
    expect((usage?.input_tokens_details as Record<string, unknown>)?.cached_tokens).toBe(5);
  });

  it("pads an empty input array so upstream providers receive non-empty messages", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [],
      },
      provider,
    );
    expect(result.upstreamPath).toBe("/v1/chat/completions");
    expect(result.upstreamBody.messages).toEqual([{ role: "user", content: "​" }]);
  });

  it("pads a missing input field so upstream providers receive non-empty messages", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
      },
      provider,
    );
    expect(result.upstreamPath).toBe("/v1/chat/completions");
    expect(result.upstreamBody.messages).toEqual([{ role: "user", content: "​" }]);
  });

  it("converts Responses API tools to Chat Completions format", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        tools: [
          {
            type: "function",
            name: "exec_command",
            description: "run commands",
            parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
          },
          {
            type: "namespace",
            name: "multi_agent_v1",
            description: "agent tools",
            tools: [{ type: "function", name: "close_agent", description: "close" }],
          },
        ],
        tool_choice: { type: "function", name: "exec_command" },
      },
      provider,
    );
    expect(result.upstreamBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "exec_command",
          description: "run commands",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      },
    ]);
    expect(result.upstreamBody.tool_choice).toEqual({ type: "function", function: { name: "exec_command" } });
  });
});
