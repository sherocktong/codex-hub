import { describe, it, expect } from "vitest";
import {
  translateResponsesRequestToChat,
  translateChatResponseToResponses,
  translateChatStreamChunkToResponses,
  createResponsesDoneChunk,
} from "../src/proxy/responses-translator.js";
import {
  getConversationMessages,
  setConversationMessages,
  mergeConversationHistory,
} from "../src/proxy/conversation-state.js";
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

  it("converts instructions to a leading system message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        instructions: [{ type: "text", text: "Be concise." }],
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("collapses system and developer messages into a single head system message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        instructions: "First instruction.",
        input: [
          { type: "message", role: "developer", content: "Second instruction." },
          { type: "message", role: "user", content: "hello" },
          { type: "message", role: "system", content: "Third instruction." },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: "First instruction." },
          { type: "text", text: "Second instruction." },
          { type: "text", text: "Third instruction." },
        ],
      },
      { role: "user", content: "hello" },
    ]);
  });

  it("maps max_output_tokens to max_tokens for non-o-series models", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        max_output_tokens: 4096,
        input: [{ type: "message", role: "user", content: "hello" }],
      },
      provider,
    );
    expect(result.upstreamBody.max_output_tokens).toBeUndefined();
    expect(result.upstreamBody.max_tokens).toBe(4096);
  });

  it("maps max_output_tokens to max_completion_tokens for o-series models", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "o3-mini",
        max_output_tokens: 4096,
        input: [{ type: "message", role: "user", content: "hello" }],
      },
      provider,
    );
    expect(result.upstreamBody.max_output_tokens).toBeUndefined();
    expect(result.upstreamBody.max_completion_tokens).toBe(4096);
    expect(result.upstreamBody.max_tokens).toBeUndefined();
  });

  it("passes through extra chat completion parameters", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [{ type: "message", role: "user", content: "hello" }],
        frequency_penalty: 0.5,
        presence_penalty: 0.2,
        seed: 42,
        user: "test-user",
      },
      provider,
    );
    expect(result.upstreamBody.frequency_penalty).toBe(0.5);
    expect(result.upstreamBody.presence_penalty).toBe(0.2);
    expect(result.upstreamBody.seed).toBe(42);
    expect(result.upstreamBody.user).toBe("test-user");
  });

  it("injects stream_options.include_usage for streaming requests", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        stream: true,
        input: [{ type: "message", role: "user", content: "hello" }],
      },
      provider,
    );
    expect(result.upstreamBody.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options while adding include_usage", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        stream: true,
        stream_options: { continuous_usage_stats: true },
        input: [{ type: "message", role: "user", content: "hello" }],
      },
      provider,
    );
    expect(result.upstreamBody.stream_options).toEqual({ continuous_usage_stats: true, include_usage: true });
  });

  it("drops tool_choice and parallel_tool_calls when tools are empty", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [{ type: "message", role: "user", content: "hello" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
      },
      provider,
    );
    expect(result.upstreamBody.tool_choice).toBeUndefined();
    expect(result.upstreamBody.parallel_tool_calls).toBeUndefined();
  });

  it("keeps tool_choice and parallel_tool_calls when tools are present", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [{ type: "message", role: "user", content: "hello" }],
        tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
        tool_choice: "auto",
        parallel_tool_calls: true,
      },
      provider,
    );
    expect(result.upstreamBody.tool_choice).toBe("auto");
    expect(result.upstreamBody.parallel_tool_calls).toBe(true);
  });

  it("canonicalizes function_call arguments", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "read_file", arguments: '{ "path": "/tmp" }' },
        ],
      },
      provider,
    );
    const assistantMsg = result.upstreamBody.messages[0] as Record<string, unknown>;
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
    expect(((toolCalls[0].function as Record<string, unknown>).arguments as string)).toBe('{"path":"/tmp"}');
  });

  it("coerces empty function_call arguments to {}", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "read_file", arguments: "   " },
        ],
      },
      provider,
    );
    const assistantMsg = result.upstreamBody.messages[0] as Record<string, unknown>;
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
    expect(((toolCalls[0].function as Record<string, unknown>).arguments as string)).toBe('{}');
  });

  it("translates function_call_output input items to Chat Completions tool messages", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", call_id: "call_abc", name: "exec_command", arguments: "{\"cmd\":\"git status\"}" },
          { type: "function_call_output", call_id: "call_abc", output: "On branch main" },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      {
        role: "assistant",
        content: null,
        reasoning_content: "tool call",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "exec_command", arguments: "{\"cmd\":\"git status\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: "On branch main" },
    ]);
  });

  it("merges reasoning that appears between a function_call and its output into the assistant message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_abc", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
          { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "Let me check the files." }] },
          { type: "function_call_output", call_id: "call_abc", output: "file.txt" },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      {
        role: "assistant",
        content: null,
        reasoning_content: "Let me check the files.",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: "file.txt" },
    ]);
  });

  it("groups consecutive function_call items into a single assistant tool_calls message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "read_file", arguments: "{\"path\":\"/etc/hosts\"}" },
          { type: "function_call", id: "call_2", name: "read_file", arguments: "{\"path\":\"/etc/resolv.conf\"}" },
          { type: "function_call_output", call_id: "call_1", output: "127.0.0.1 localhost" },
          { type: "function_call_output", call_id: "call_2", output: "nameserver 8.8.8.8" },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toHaveLength(3);
    const assistantMsg = result.upstreamBody.messages[0] as Record<string, unknown>;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toHaveLength(2);
  });

  it("translates a function_call input item to an assistant tool_calls message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_xyz", name: "read_file", arguments: "{\"path\":\"/etc/hosts\"}" },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      {
        role: "assistant",
        content: null,
        reasoning_content: "tool call",
        tool_calls: [
          {
            id: "call_xyz",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"/etc/hosts\"}" },
          },
        ],
      },
    ]);
  });

  it("merges a following assistant message into a pending tool_calls assistant message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me check." }] },
          { type: "function_call_output", call_id: "call_1", output: "file.txt" },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toHaveLength(2);
    const assistantMsg = result.upstreamBody.messages[0] as Record<string, unknown>;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.content).toEqual([{ type: "text", text: "Let me check." }]);
    expect(result.upstreamBody.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file.txt",
    });
  });

  it("merges embedded reasoning_content when merging an assistant message into a tool-call message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
          {
            type: "message",
            role: "assistant",
            reasoning_content: "Let me check the files.",
            content: [{ type: "output_text", text: "Checking." }],
          },
          { type: "function_call_output", call_id: "call_1", output: "file.txt" },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toHaveLength(2);
    const assistantMsg = result.upstreamBody.messages[0] as Record<string, unknown>;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.content).toEqual([{ type: "text", text: "Checking." }]);
    expect(assistantMsg.reasoning_content).toBe("Let me check the files.");
  });

  it("backfills reasoning_content for assistant tool-call messages without reasoning", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          { type: "function_call_output", call_id: "call_1", output: "Readme content" },
        ],
      },
      provider,
    );
    const assistantMsg = result.upstreamBody.messages[0] as Record<string, unknown>;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBeNull();
    expect(assistantMsg.reasoning_content).toBe("tool call");
  });

  it("preserves reasoning_content on input assistant messages", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          {
            type: "message",
            role: "assistant",
            reasoning_content: "I need to preserve thinking history.",
            content: [{ type: "output_text", text: "Done." }],
          },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      {
        role: "assistant",
        reasoning_content: "I need to preserve thinking history.",
        content: [{ type: "text", text: "Done." }],
      },
    ]);
  });

  it("attaches reasoning items as reasoning_content on assistant messages", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Need to inspect the repo." }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will check the files." }],
          },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      {
        role: "assistant",
        reasoning_content: "Need to inspect the repo.",
        content: [{ type: "text", text: "I will check the files." }],
      },
    ]);
  });

  it("attaches trailing reasoning to the previous assistant before a user turn", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          {
            type: "message",
            role: "assistant",
            content: "I checked the files.",
          },
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "The answer came from README." }],
          },
          {
            type: "message",
            role: "user",
            content: "Continue",
          },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      {
        role: "assistant",
        content: "I checked the files.",
        reasoning_content: "The answer came from README.",
      },
      { role: "user", content: "Continue" },
    ]);
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

  it("drops streaming tool calls that never receive a function name", () => {
    const ctx = { state: {} };
    const originalBody = { model: "kimi-k2.7" };

    translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-bad-tool",
        created: 1234567890,
        choices: [{ delta: { role: "assistant" } }],
      },
      originalBody,
    );

    const deltaChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-bad-tool",
        created: 1234567890,
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_bad", function: { arguments: "{}" } }],
            },
          },
        ],
      },
      originalBody,
    );
    expect(deltaChunk?.some((e) => e.type === "response.output_item.added")).toBe(false);

    const finalChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-bad-tool",
        created: 1234567890,
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      },
      originalBody,
    );
    expect(finalChunk?.some((e) => e.type === "response.output_item.done")).toBe(false);
    const failed = finalChunk?.find((e) => e.type === "response.failed") as Record<string, unknown> | undefined;
    expect(failed).toBeDefined();
    expect(((failed?.response as Record<string, unknown>)?.error as Record<string, unknown>)?.type).toBe(
      "upstream_tool_call_dropped",
    );
  });

  it("emits a streaming tool call once its name arrives in a later delta", () => {
    const ctx = { state: {} };
    const originalBody = { model: "kimi-k2.7" };

    translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-late-name",
        created: 1234567890,
        choices: [{ delta: { role: "assistant" } }],
      },
      originalBody,
    );

    const firstDelta = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-late-name",
        created: 1234567890,
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_late", function: { arguments: "{}" } }] } }],
      },
      originalBody,
    );
    expect(firstDelta?.some((e) => e.type === "response.output_item.added")).toBe(false);

    const nameDelta = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-late-name",
        created: 1234567890,
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "calculator" } }] } }],
      },
      originalBody,
    );
    const added = nameDelta?.find((e) => e.type === "response.output_item.added") as Record<string, unknown> | undefined;
    expect(added).toBeDefined();
    expect(((added?.item as Record<string, unknown>) ?? {}).name).toBe("calculator");

    const finalChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-late-name",
        created: 1234567890,
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      },
      originalBody,
    );
    expect(finalChunk?.some((e) => e.type === "response.function_call_arguments.done")).toBe(true);
    expect(finalChunk?.some((e) => e.type === "response.output_item.done")).toBe(true);
  });

  it("drops non-streaming tool calls with missing function names", () => {
    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-nonstream-bad",
        created: 1234567890,
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                { id: "call_good", function: { name: "calculator", arguments: "{}" } },
                { id: "call_bad", function: { name: "", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      { model: "kimi-k2.7" },
    );
    const output = (translated.output as Array<Record<string, unknown>>) ?? [];
    expect(output).toHaveLength(1);
    expect(output[0].name).toBe("calculator");
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

  it("translates response_format to Chat Completions shape", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        response_format: {
          type: "json_schema",
          name: "greeting",
          schema: { type: "object", properties: { text: { type: "string" } } },
          strict: true,
        },
      },
      provider,
    );
    expect(result.upstreamBody.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "greeting",
        schema: { type: "object", properties: { text: { type: "string" } } },
        strict: true,
      },
    });
  });

  it("includes status in translated non-streaming response", () => {
    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "kimi-k2-5-coding",
        choices: [{ message: { role: "assistant", content: "Hi there" } }],
      },
      { model: "kimi-k2.7" },
    );
    expect(translated.status).toBe("completed");
  });

  it("maps finish_reason length to incomplete status and details", () => {
    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "kimi-k2-5-coding",
        choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "length" }],
      },
      { model: "kimi-k2.7" },
    );
    expect(translated.status).toBe("incomplete");
    expect(translated.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("emits a reasoning output item from message reasoning_content", () => {
    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "kimi-k2-5-coding",
        choices: [
          {
            message: { role: "assistant", reasoning_content: "Let me think.", content: "Answer." },
          },
        ],
      },
      { model: "kimi-k2.7" },
    );
    const output = translated.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Let me think." }],
    });
    expect(output[1]).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Answer." }],
    });
  });

  it("strips a leading think block into a reasoning output item", () => {
    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "kimi-k2-5-coding",
        choices: [
          {
            message: {
              role: "assistant",
              content: "<think>Hidden reasoning</think>\nFinal answer.",
            },
          },
        ],
      },
      { model: "kimi-k2.7" },
    );
    const output = translated.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Hidden reasoning" }],
    });
    expect(output[1]).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Final answer." }],
    });
  });

  it("canonicalizes non-streaming function_call arguments", () => {
    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "kimi-k2-5-coding",
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                { id: "call_1", function: { name: "calculator", arguments: '{ "x": 1 }' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      { model: "kimi-k2.7" },
    );
    const output = translated.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      type: "function_call",
      name: "calculator",
      arguments: '{"x":1}',
    });
  });

  it("translates reasoning_content to Responses reasoning events", () => {
    const ctx = { state: {} };
    const originalBody = { model: "kimi-k2.7" };

    const firstChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-reason",
        created: 1234567890,
        choices: [{ delta: { role: "assistant", reasoning_content: "Let me think." } }],
      },
      originalBody,
    );
    expect(firstChunk?.[0].type).toBe("response.created");
    expect(firstChunk?.some((e) => e.type === "response.output_item.added")).toBe(true);
    expect(firstChunk?.some((e) => e.type === "response.reasoning_summary_part.added")).toBe(true);
    expect(firstChunk?.some((e) => e.type === "response.reasoning_summary_text.delta")).toBe(true);

    const finalChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-reason",
        created: 1234567890,
        choices: [{ delta: {}, finish_reason: "stop" }],
      },
      originalBody,
    );
    expect(finalChunk?.some((e) => e.type === "response.reasoning_summary_text.done")).toBe(true);
    expect(finalChunk?.some((e) => e.type === "response.output_item.done")).toBe(true);
    expect(finalChunk?.some((e) => e.type === "response.completed")).toBe(true);
  });

  it("routes a leading inline think block to a reasoning item", () => {
    const ctx = { state: {} };
    const originalBody = { model: "kimi-k2.7" };

    const firstChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-think",
        created: 1234567890,
        choices: [{ delta: { role: "assistant", content: "<think>" } }],
      },
      originalBody,
    );
    expect(firstChunk?.[0].type).toBe("response.created");
    expect(firstChunk?.some((e) => e.type === "response.output_item.added")).toBe(false);

    const reasoningChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-think",
        created: 1234567890,
        choices: [{ delta: { content: "Hidden reasoning</think>Answer." } }],
      },
      originalBody,
    );
    expect(reasoningChunk?.some((e) => e.type === "response.output_item.added")).toBe(true);
    expect(reasoningChunk?.some((e) => e.type === "response.reasoning_summary_text.delta")).toBe(true);
    expect(reasoningChunk?.some((e) => e.type === "response.output_text.delta")).toBe(true);

    const finalChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-think",
        created: 1234567890,
        choices: [{ delta: {}, finish_reason: "stop" }],
      },
      originalBody,
    );
    expect(finalChunk?.some((e) => e.type === "response.output_item.done")).toBe(true);
    expect(finalChunk?.some((e) => e.type === "response.completed")).toBe(true);
  });

  it("canonicalizes streaming function_call arguments on done", () => {
    const ctx = { state: {} };
    const originalBody = { model: "kimi-k2.7" };

    translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-tool-canon",
        created: 1234567890,
        choices: [{ delta: { role: "assistant" } }],
      },
      originalBody,
    );

    translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-tool-canon",
        created: 1234567890,
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "calculator", arguments: '{ "x": 1' } }],
            },
          },
        ],
      },
      originalBody,
    );

    translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-tool-canon",
        created: 1234567890,
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' }' } }] } }],
      },
      originalBody,
    );

    const finalChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-tool-canon",
        created: 1234567890,
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      },
      originalBody,
    );
    const doneEvent = finalChunk?.find((e) => e.type === "response.function_call_arguments.done") as
      | Record<string, unknown>
      | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent.arguments).toBe('{"x":1}');
  });

  it("maps streaming finish_reason length to incomplete status", () => {
    const ctx = { state: { textOutputItemAdded: true, accumulatedText: "Hello" } };
    const translated = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-length",
        created: 1234567890,
        choices: [{ delta: {}, finish_reason: "length" }],
      },
      { model: "kimi-k2.7" },
    );
    const completed = translated.find((e) => e.type === "response.completed") as Record<string, unknown> | undefined;
    expect(completed).toBeDefined();
    expect((completed?.response as Record<string, unknown>)?.status).toBe("incomplete");
    expect((completed?.response as Record<string, unknown>)?.incomplete_details).toEqual({
      reason: "max_output_tokens",
    });
  });

  it("emits response.failed for an upstream error chunk", () => {
    const ctx = { state: {} };
    const translated = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-err",
        error: { message: "context length exceeded", type: "invalid_request_error", code: "context_length" },
      },
      { model: "kimi-k2.7" },
    );
    expect(translated).toHaveLength(1);
    expect(translated[0].type).toBe("response.failed");
    const error = (translated[0].response as Record<string, unknown>)?.error as Record<string, unknown>;
    expect(error?.message).toBe("context length exceeded");
    expect(error?.type).toBe("invalid_request_error");
    expect(error?.code).toBe("context_length");
  });

  it("allocates distinct output indices for text and tool calls", () => {
    const ctx = { state: {} };
    const originalBody = { model: "kimi-k2.7" };

    const textChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-mixed",
        created: 1234567890,
        choices: [{ delta: { role: "assistant", content: "I will run a command." } }],
      },
      originalBody,
    );

    const toolChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-mixed",
        created: 1234567890,
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec_command" } }],
            },
          },
        ],
      },
      originalBody,
    );

    const textAdded = textChunk?.find(
      (e) => e.type === "response.output_item.added" && (e.item as Record<string, unknown>)?.type === "message",
    ) as Record<string, unknown> | undefined;
    const toolAdded = toolChunk?.find(
      (e) => e.type === "response.output_item.added" && (e.item as Record<string, unknown>)?.type === "function_call",
    ) as Record<string, unknown> | undefined;

    expect(textAdded?.output_index).toBe(0);
    expect(toolAdded?.output_index).toBe(1);
  });

  it("synthesizes a matching assistant tool_calls entry for orphan function_call_output items", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call_output", call_id: "call_orphan", output: "result" },
        ],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      {
        role: "assistant",
        content: null,
        reasoning_content: "tool call",
        tool_calls: [
          {
            id: "call_orphan",
            type: "function",
            function: { name: "unknown", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_orphan", content: "result" },
    ]);
  });

  it("drops function_call items with placeholder 'unknown' names from request history", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "unknown", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "error" },
        ],
      },
      provider,
    );
    const messages = result.upstreamBody.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("assistant");
    // The original malformed function_call is dropped; the matching output is
    // kept as an orphan with a synthetic placeholder tool_call entry.
    expect(messages[0].tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "unknown", arguments: "{}" },
      },
    ]);
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "error" });
  });

  it("drops function_call items with empty names from request history", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "", arguments: "{}" },
          { type: "function_call", id: "call_2", name: "exec_command", arguments: '{"cmd":"ls"}' },
          { type: "function_call_output", call_id: "call_1", output: "orphan" },
          { type: "function_call_output", call_id: "call_2", output: "file.txt" },
        ],
      },
      provider,
    );
    const messages = result.upstreamBody.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("assistant");
    expect((messages[0].tool_calls as Array<Record<string, unknown>>).map((tc) => (tc.function as Record<string, unknown>).name)).toEqual([
      "exec_command",
    ]);
    expect(messages[1].role).toBe("assistant");
    expect((messages[1].tool_calls as Array<Record<string, unknown>>).map((tc) => (tc.function as Record<string, unknown>).name)).toEqual([
      "unknown",
    ]);
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "orphan" });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_2", content: "file.txt" });
  });

  it("preserves reasoning when dropping malformed function_call items", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "unknown", arguments: "{}", reasoning_content: "Need to think." },
          { type: "message", role: "assistant", content: "I cannot do that." },
        ],
      },
      provider,
    );
    const messages = result.upstreamBody.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].reasoning_content).toBe("Need to think.");
    expect(messages[0].content).toBe("I cannot do that.");
    expect(messages[0].tool_calls).toBeUndefined();
  });

  it("drops 'unknown' tool_calls from non-streaming responses", () => {
    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-unknown",
        object: "chat.completion",
        model: "kimi-k2-5-coding",
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                { id: "call_1", function: { name: "unknown", arguments: "{}" } },
                { id: "call_2", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      { model: "kimi-k2.7" },
    );
    const output = translated.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      type: "function_call",
      id: "call_2",
      name: "exec_command",
      arguments: '{"cmd":"ls"}',
    });
  });

  it("does not emit 'unknown' tool_calls from streaming responses", () => {
    const ctx = { state: {} };
    const originalBody = { model: "kimi-k2.7" };

    const announceChunk = translateChatStreamChunkToResponses(
      ctx,
      {
        id: "chatcmpl-stream-unknown",
        created: 1234567890,
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "unknown" } },
                { index: 1, id: "call_2", type: "function", function: { name: "exec_command" } },
              ],
            },
          },
        ],
      },
      originalBody,
    );

    const added = announceChunk?.filter(
      (e) => e.type === "response.output_item.added" && (e.item as Record<string, unknown>)?.type === "function_call",
    ) as Array<Record<string, unknown>> | undefined;
    expect(added).toHaveLength(1);
    expect((added?.[0].item as Record<string, unknown>)?.name).toBe("exec_command");
  });

  it("translates bare input_text items into a user message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [{ type: "input_text", text: "scan the code" }],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "scan the code" }] },
    ]);
  });

  it("translates bare input_image items into a user message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [{ type: "input_image", image_url: "https://example.com/img.png" }],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: "https://example.com/img.png" }] },
    ]);
  });

  it("translates bare input_file items into a user message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [{ type: "input_file", file_id: "file_123" }],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "[file: file_123]" }] },
    ]);
  });

  it("flushes pending tool calls before emitting a bare input_text user message", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "function_call", id: "call_1", name: "exec_command", arguments: '{"cmd":"ls"}' },
          { type: "input_text", text: "Now summarize the results." },
        ],
      },
      provider,
    );
    const messages = result.upstreamBody.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "exec_command", arguments: '{"cmd":"ls"}' },
      },
    ]);
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Now summarize the results." }],
    });
  });

  it("does not let pending reasoning leak across a bare input_text user turn", () => {
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        input: [
          { type: "reasoning", content: "Need to think." },
          { type: "input_text", text: "Continue." },
        ],
      },
      provider,
    );
    const messages = result.upstreamBody.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Continue." }],
    });
  });
});

describe("conversation state for previous_response_id", () => {
  it("merges prior history with a new request", () => {
    const prior = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    setConversationMessages("resp_123", prior);
    const merged = mergeConversationHistory("resp_123", "new sys", [
      { role: "system", content: "ignored" },
      { role: "user", content: "follow-up" },
    ]);
    expect(merged).toEqual([
      { role: "system", content: "new sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "follow-up" },
    ]);
  });

  it("falls back to prior system message when new instructions are absent", () => {
    setConversationMessages("resp_prior", [
      { role: "system", content: "prior sys" },
      { role: "user", content: "hi" },
    ]);
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        previous_response_id: "resp_prior",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "again" }] }],
      },
      provider,
    );
    expect(result.upstreamBody.messages).toEqual([
      { role: "system", content: "prior sys" },
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
  });

  it("replays stored history when previous_response_id is supplied", () => {
    setConversationMessages("resp_prev", [
      { role: "system", content: "sys" },
      { role: "user", content: "scan the code" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
    ]);
    const ctx = { state: {} };
    const result = translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        instructions: "sys",
        previous_response_id: "resp_prev",
        input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
      },
      provider,
      ctx,
    );
    expect(result.upstreamBody.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "scan the code" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ]);
    expect(ctx.state.conversationMessages).toEqual(result.upstreamBody.messages);
  });

  it("stores the conversation under the response id after a non-streaming response", () => {
    const ctx = { state: {} };
    translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        instructions: "sys",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      },
      provider,
      ctx,
    );
    translateChatResponseToResponses(
      {
        id: "chatcmpl-abc",
        object: "chat.completion",
        created: 1,
        model: "kimi-k3",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi there" },
            finish_reason: "stop",
          },
        ],
      },
      { model: "kimi-k2.7" },
      ctx,
    );
    expect(getConversationMessages("resp_chatcmpl-abc")).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("stores the conversation under the response id after a streaming response completes", () => {
    const ctx = { state: {} };
    translateResponsesRequestToChat(
      {
        model: "kimi-k2.7",
        instructions: "sys",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      },
      provider,
      ctx,
    );
    // First delta establishes response id and starts text.
    translateChatStreamChunkToResponses(
      ctx,
      { id: "chatcmpl-stream", object: "chat.completion.chunk", created: 1, model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] },
      { model: "kimi-k2.7" },
    );
    // Final delta finishes.
    translateChatStreamChunkToResponses(
      ctx,
      { id: "chatcmpl-stream", object: "chat.completion.chunk", created: 1, model: "kimi-k3", choices: [{ index: 0, delta: { content: " there" }, finish_reason: "stop" }] },
      { model: "kimi-k2.7" },
    );
    expect(getConversationMessages("chatcmpl-stream")).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "hi there" },
    ]);
  });
});
