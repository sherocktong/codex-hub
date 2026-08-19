/**
 * Translates OpenAI Responses API requests/responses to Chat Completions format.
 *
 * Kimi and Qianwen expose OpenAI-compatible Chat Completions but not the newer
 * Responses API. Codex CLI's default `wire_api = "responses"` sends requests to
 * /v1/responses, so the proxy must translate them to /v1/chat/completions.
 */

import type { ProviderConfig } from "../types.js";

// Additional OpenAI Chat Completions parameters that should be passed through
// from a Responses API request when present. Mirrors cc-switch's
// EXTRA_CHAT_PASSTHROUGH_FIELDS.
const EXTRA_CHAT_PASSTHROUGH_FIELDS = [
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "metadata",
  "n",
  "parallel_tool_calls",
  "presence_penalty",
  "seed",
  "service_tier",
  "stream_options",
  "top_logprobs",
  "user",
];

export interface TranslatedBodies {
  upstreamPath: string;
  upstreamBody: Record<string, unknown>;
  originalBody: Record<string, unknown>;
}

export function shouldTranslateResponsesToChat(provider: ProviderConfig): boolean {
  return provider.responsesToChatCompletions === true;
}

export function translateResponsesRequestToChat(
  body: Record<string, unknown>,
  provider: ProviderConfig,
): TranslatedBodies {
  const upstreamBody: Record<string, unknown> = { ...body };
  delete upstreamBody.input;

  const messages: Array<Record<string, unknown>> = [];

  // OpenAI's Responses API uses `instructions` for system-level developer text.
  // Chat Completions providers expect a leading system message.
  const instructionsText = typeof body.instructions === "string"
    ? body.instructions
    : extractInstructionsText(body.instructions);
  if (instructionsText) {
    messages.push({ role: "system", content: instructionsText });
  }

  const input = body.input as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(input)) {
    messages.push(...buildMessages(input));
  }

  // MiniMax and some other strict gateways reject intermediate system messages,
  // so collapse all system/developer messages into a single head message.
  upstreamBody.messages = collapseSystemMessagesToHead(messages);

  // Providers such as Kimi reject chat-completion requests whose messages array
  // is empty ("messages must not be empty"). Codex occasionally sends an empty
  // input array (e.g. during startup probes), so pad with a harmless placeholder
  // message to keep the connection healthy instead of aborting the WebSocket.
  if ((upstreamBody.messages as Array<Record<string, unknown>>).length === 0) {
    upstreamBody.messages = [{ role: "user", content: "​" }];
  }

  // Copy common params that are shared between the two APIs.
  for (const key of ["model", "stream", "temperature", "top_p", "max_tokens", "stop"]) {
    if (key in body) {
      upstreamBody[key] = body[key];
    }
  }

  // Responses API uses `max_output_tokens`; Chat Completions uses `max_tokens`
  // (or `max_completion_tokens` for OpenAI o-series models).
  const modelName = (upstreamBody.model as string) ?? "";
  if ("max_output_tokens" in body) {
    if (isOpenAIOSeries(modelName)) {
      upstreamBody.max_completion_tokens = body.max_output_tokens;
    } else {
      upstreamBody.max_tokens = body.max_output_tokens;
    }
    delete upstreamBody.max_output_tokens;
  }
  if ("max_completion_tokens" in body) {
    upstreamBody.max_completion_tokens = body.max_completion_tokens;
  }

  // Pass through additional OpenAI-compatible params that Responses API and Chat
  // Completions share. Mirrors cc-switch's EXTRA_CHAT_PASSTHROUGH_FIELDS.
  for (const key of EXTRA_CHAT_PASSTHROUGH_FIELDS) {
    if (key in body) {
      upstreamBody[key] = body[key];
    }
  }

  // Convert response_format from Responses API shape to Chat Completions shape.
  // Responses: { type: "json_schema", name, schema, strict }
  // Chat:     { type: "json_schema", json_schema: { name, schema, strict } }
  if (body.response_format) {
    upstreamBody.response_format = convertResponseFormat(body.response_format as Record<string, unknown>);
  }

  // Convert tools from Responses API format to Chat Completions format.
  if (body.tools) {
    upstreamBody.tools = convertTools(body.tools as Array<Record<string, unknown>>);
  }
  if (body.tool_choice !== undefined) {
    upstreamBody.tool_choice = convertToolChoice(body.tool_choice as string | Record<string, unknown>);
  }

  // Strict OpenAI-compatible upstreams (vLLM, enterprise gateways) reject
  // requests that carry tool_choice or parallel_tool_calls without a non-empty
  // tools array. Drop both fields when tools ended up absent or empty.
  const toolsArray = upstreamBody.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(toolsArray) || toolsArray.length === 0) {
    delete upstreamBody.tool_choice;
    delete upstreamBody.parallel_tool_calls;
  }

  // OpenAI-compatible upstreams do not include usage in streaming SSE chunks by
  // default. Explicitly request it so Kimi/Qianwen emit final usage chunks.
  if (upstreamBody.stream === true) {
    upstreamBody.stream_options = {
      ...(upstreamBody.stream_options as Record<string, unknown> | undefined),
      include_usage: true,
    };
  }

  // Normalize model to a provider-supported model id.
  upstreamBody.model = normalizeModel(upstreamBody.model as string | undefined, provider);

  return {
    upstreamPath: "/v1/chat/completions",
    upstreamBody,
    originalBody: body,
  };
}

function buildMessages(input: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const pendingToolCallIds = new Set<string>();
  const pendingReasoning: string[] = [];
  let lastAssistantIndex = -1;

  const appendPendingReasoning = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    pendingReasoning.push(trimmed);
  };

  const consumePendingReasoning = (): string | undefined => {
    if (pendingReasoning.length === 0) return undefined;
    const text = pendingReasoning.join("\n\n");
    pendingReasoning.length = 0;
    return text || undefined;
  };

  const attachReasoningToMessage = (msg: Record<string, unknown>, reasoning: string): void => {
    const existing = msg.reasoning_content as string | undefined;
    if (typeof existing === "string" && existing.trim()) {
      msg.reasoning_content = `${existing.trim()}\n\n${reasoning}`;
    } else {
      msg.reasoning_content = reasoning;
    }
  };

  const appendReasoningToAssistant = (): boolean => {
    const reasoning = consumePendingReasoning();
    if (!reasoning) return false;
    if (lastAssistantIndex < 0) return false;
    const msg = messages[lastAssistantIndex];
    if (msg.role !== "assistant") return false;
    attachReasoningToMessage(msg, reasoning);
    return true;
  };

  const synthesizeToolCallForOutput = (callId: string): Record<string, unknown> => ({
    id: callId,
    type: "function",
    function: { name: "unknown", arguments: "{}" },
  });

  for (const item of input) {
    if (item.type === "function_call") {
      const toolCall = translateFunctionCall(item);
      const toolCallId = (toolCall.id as string) ?? "";

      // Some function_call items carry embedded reasoning that belongs to this
      // tool-call turn; accumulate it so it can be attached as reasoning_content.
      if (typeof item.reasoning_content === "string") {
        appendPendingReasoning(item.reasoning_content);
      }

      if (
        lastAssistantIndex >= 0 &&
        messages[lastAssistantIndex].role === "assistant" &&
        pendingToolCallIds.size > 0
      ) {
        const existing = messages[lastAssistantIndex].tool_calls as Array<Record<string, unknown>> | undefined;
        if (existing) {
          existing.push(toolCall);
          pendingToolCallIds.add(toolCallId);
          appendReasoningToAssistant();
          continue;
        }
      }

      // Start a new assistant message for this batch of tool calls.
      const reasoning = consumePendingReasoning();
      const message: Record<string, unknown> = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall],
      };
      if (reasoning) {
        message.reasoning_content = reasoning;
      }
      messages.push(message);
      lastAssistantIndex = messages.length - 1;
      pendingToolCallIds.clear();
      pendingToolCallIds.add(toolCallId);
      continue;
    }

    if (item.type === "reasoning") {
      const text = extractReasoningText(item);
      if (text) appendPendingReasoning(text);
      continue;
    }

    if (item.type === "function_call_output") {
      // Attach any trailing reasoning to the pending tool-call assistant message
      // before emitting the tool response; Kimi expects reasoning_content on
      // assistant tool-call turns and tool messages immediately after.
      appendReasoningToAssistant();
      const toolCallId = ((item.call_id as string) ?? (item.id as string)) || "";
      const output = item.output;

      // Some upstream payloads contain function_call_output items without a
      // matching function_call (orphan outputs). Kimi rejects tool messages whose
      // tool_call_id does not correspond to a preceding assistant tool_calls
      // entry, so synthesize a placeholder assistant message for the orphan.
      if (toolCallId && !pendingToolCallIds.has(toolCallId)) {
        const toolCall = synthesizeToolCallForOutput(toolCallId);
        const message: Record<string, unknown> = {
          role: "assistant",
          content: null,
          reasoning_content: "tool call",
          tool_calls: [toolCall],
        };
        messages.push(message);
        lastAssistantIndex = messages.length - 1;
        pendingToolCallIds.add(toolCallId);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
      });
      pendingToolCallIds.delete(toolCallId);
      continue;
    }

    if (item.type === "message" && item.role === "assistant") {
      const translated = translateAssistantMessage(item);

      // If there are unresolved assistant tool_calls from earlier, append this
      // assistant text/reasoning onto that same assistant message so tool results
      // remain immediately adjacent to their tool_calls.
      if (
        pendingToolCallIds.size > 0 &&
        lastAssistantIndex >= 0 &&
        messages[lastAssistantIndex].role === "assistant" &&
        translated.content &&
        !translated.tool_calls
      ) {
        const target = messages[lastAssistantIndex];
        const existingContent = target.content;
        if (Array.isArray(existingContent)) {
          (existingContent as Array<Record<string, unknown>>).push(
            ...(Array.isArray(translated.content)
              ? (translated.content as Array<Record<string, unknown>>)
              : [{ type: "text", text: translated.content }]),
          );
        } else if (typeof existingContent === "string") {
          target.content = `${existingContent}\n${String(translated.content)}`;
        } else {
          target.content = translated.content;
        }
        // Merge the assistant message's own reasoning_content (if any) and any
        // pending reasoning into the target tool-call message.
        if (typeof translated.reasoning_content === "string") {
          appendPendingReasoning(translated.reasoning_content);
        }
        appendReasoningToAssistant();
        continue;
      }

      // Pending reasoning for a standalone assistant message becomes its
      // reasoning_content rather than being lost.
      const reasoning = consumePendingReasoning();
      if (reasoning) attachReasoningToMessage(translated, reasoning);
      messages.push(translated);
      lastAssistantIndex = messages.length - 1;
      pendingToolCallIds.clear();
      const ids = extractToolCallIds(translated);
      for (const id of ids) pendingToolCallIds.add(id);
      continue;
    }

    // Non-assistant turn boundaries: do not let reasoning leak across user/system
    // turns; attach it to the previous assistant if one exists.
    appendReasoningToAssistant();

    const msg = translateInputItem(item);
    messages.push(msg);

    if (msg.role === "assistant") {
      lastAssistantIndex = messages.length - 1;
      pendingToolCallIds.clear();
      const ids = extractToolCallIds(msg);
      for (const id of ids) pendingToolCallIds.add(id);
    } else {
      lastAssistantIndex = -1;
      pendingToolCallIds.clear();
    }
  }

  // Any reasoning left at the end of the input is trailing reasoning for the
  // last assistant turn.
  appendReasoningToAssistant();

  backfillToolCallReasoningPlaceholders(messages);
  return messages;
}

function extractInstructionsText(instructions: unknown): string {
  if (typeof instructions === "string") return instructions;
  if (Array.isArray(instructions)) {
    return instructions
      .map((part: Record<string, unknown>) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function isOpenAIOSeries(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4");
}

function collapseSystemMessagesToHead(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const systemParts: Array<Record<string, unknown>> = [];
  const collapsed: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system") {
      const content = message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === "object") {
            systemParts.push(part as Record<string, unknown>);
          }
        }
      } else if (typeof content === "string" && content) {
        systemParts.push({ type: "text", text: content });
      }
      continue;
    }
    collapsed.push(message);
  }

  if (systemParts.length === 0) return collapsed;

  // Keep a lone text system message as a plain string for compatibility with
  // providers/tests that expect the simpler shape; only use the array form
  // when there are multiple parts to merge.
  const systemContent = systemParts.length === 1 && systemParts[0].type === "text"
    ? systemParts[0].text
    : systemParts;

  return [{ role: "system", content: systemContent }, ...collapsed];
}

function translateFunctionCall(item: Record<string, unknown>): Record<string, unknown> {
  const toolCallId = ((item.call_id as string) ?? (item.id as string)) || "";
  return {
    id: toolCallId,
    type: "function",
    function: {
      name: (item.name as string) ?? "",
      arguments: canonicalizeToolArguments(item.arguments),
    },
  };
}

function canonicalizeToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === "string") {
    const trimmed = argumentsValue.trim();
    if (trimmed.length === 0) return "{}";
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed);
    } catch {
      return trimmed;
    }
  }
  return JSON.stringify(argumentsValue ?? {});
}

function extractReasoningText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  const summary = item.summary;
  if (Array.isArray(summary)) {
    return summary
      .map((part: Record<string, unknown>) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function extractToolCallIds(msg: Record<string, unknown>): string[] {
  const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((toolCall) => ((toolCall.id ?? toolCall.call_id) as string | undefined) ?? "")
    .filter(Boolean);
}

function translateAssistantMessage(item: Record<string, unknown>): Record<string, unknown> {
  const content = item.content;
  const translated: Record<string, unknown> = { role: "assistant" };

  // Preserve tool_calls and reasoning_content that may already be present on
  // assistant messages (e.g. from a previous turn's history).
  if (item.tool_calls) {
    translated.tool_calls = item.tool_calls;
  }
  if (typeof item.reasoning_content === "string") {
    translated.reasoning_content = item.reasoning_content;
  }

  const translatedContent = translateContent(content);
  if (
    (Array.isArray(translatedContent) && translatedContent.length === 0) ||
    translatedContent === ""
  ) {
    // Assistant tool-call messages must have content: null; plain assistant
    // messages need a harmless filler so providers reject empty content.
    translated.content = translated.tool_calls ? null : "​";
  } else {
    translated.content = translatedContent;
  }

  return translated;
}

function backfillToolCallReasoningPlaceholders(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (
      message.role !== "assistant" ||
      !Array.isArray(toolCalls) ||
      toolCalls.length === 0
    ) {
      continue;
    }

    const existing = message.reasoning_content as string | undefined;
    if (typeof existing !== "string" || !existing.trim()) {
      // Kimi/Moonshot/DeepSeek thinking models require every assistant message
      // that carries tool_calls to have non-empty reasoning_content. Use a
      // minimal placeholder when no real reasoning was preserved.
      message.reasoning_content = "tool call";
    }
  }
}

function translateInputItem(item: Record<string, unknown>): Record<string, unknown> {
  // A compaction item carries an opaque summary blob produced by a previous
  // /v1/responses/compact call. Present it to the Chat Completions model as a
  // user message so the conversation can continue from the checkpoint.
  if (item.type === "compaction") {
    const encrypted = item.encrypted_content;
    const summary = typeof encrypted === "string" ? encrypted : JSON.stringify(item);
    return { role: "user", content: `[context checkpoint]\n${summary}` };
  }

  let role = typeof item.role === "string" ? item.role : "user";
  // OpenAI's Responses API uses 'developer' for system instructions; Kimi/Qianwen only accept 'system'.
  if (role === "developer") role = "system";

  if (item.type === "message" || item.type === undefined) {
    const content = item.content;
    const translated: Record<string, unknown> = { role };

    // Preserve tool_calls and reasoning_content for assistant messages.
    if (item.tool_calls) {
      translated.tool_calls = item.tool_calls;
    }
    if (role === "assistant" && typeof item.reasoning_content === "string") {
      translated.reasoning_content = item.reasoning_content;
    }

    const translatedContent = translateContent(content);
    // Kimi rejects messages whose content is an empty array or empty string
    // ("must not be empty"). Use a single zero-width space as a harmless filler,
    // except for assistant messages with tool_calls, which must use content: null.
    if (
      (Array.isArray(translatedContent) && translatedContent.length === 0) ||
      translatedContent === ""
    ) {
      translated.content = translated.tool_calls ? null : "​";
    } else {
      translated.content = translatedContent;
    }

    return translated;
  }

  // Fallback: pass the item through as-is and let the upstream decide.
  return { role, content: JSON.stringify(item) };
}

function translateContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  // Convert Responses content parts to Chat Completions content parts.
  return content
    .map((part: Record<string, unknown>) => {
      const type = part.type;
      if (type === "input_text" || type === "output_text") {
        return { type: "text", text: part.text ?? "" };
      }
      if (type === "input_image") {
        if (part.image_url) return { type: "image_url", image_url: part.image_url };
        if (part.file_id) return { type: "text", text: `[image: ${part.file_id}]` };
        return { type: "text", text: "[image]" };
      }
      if (type === "input_file") {
        return { type: "text", text: `[file: ${part.file_id ?? ""}]` };
      }
      // Pass through anything we do not recognize.
      return part;
    })
    .filter(Boolean);
}

function normalizeModel(model: string | undefined, provider: ProviderConfig): string {
  if (!model) return provider.models[0] || "gpt-4o";
  if (provider.modelMappings?.[model]) return provider.modelMappings[model];
  if (provider.models.includes(model)) return model;
  return provider.models[0] || model;
}

function convertTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (tool.type === "function") {
      // Responses API tools have name/description/parameters/strict at the top level.
      // Chat Completions expects them nested under a "function" object.
      const { type, name, description, parameters, strict, ...rest } = tool;
      converted.push({
        type,
        function: {
          name,
          description,
          parameters,
          strict,
          ...rest,
        },
      });
    }
    // Namespace and other advanced tool types are not supported by Kimi/Qianwen Chat Completions.
  }
  return converted;
}

function convertToolChoice(toolChoice: string | Record<string, unknown>): string | Record<string, unknown> {
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function") {
    // Responses API: { type: "function", name: "..." }
    // Chat Completions: { type: "function", function: { name: "..." } }
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }
  return toolChoice;
}

function convertResponseFormat(responseFormat: Record<string, unknown>): Record<string, unknown> {
  if (responseFormat.type !== "json_schema") {
    return responseFormat;
  }
  const { type, name, schema, strict, ...rest } = responseFormat;
  return {
    type,
    json_schema: {
      name,
      schema,
      strict,
      ...rest,
    },
  };
}

export function translateChatResponseToResponses(
  chatResponse: Record<string, unknown>,
  originalBody: Record<string, unknown>,
): Record<string, unknown> {
  const choices = chatResponse.choices as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0];
  const message = firstChoice?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;

  const output: Array<Record<string, unknown>> = [];
  if (toolCalls && toolCalls.length > 0) {
    // Responses API represents function calls as separate output items of type "function_call".
    for (const toolCall of toolCalls) {
      const fn = toolCall.function as Record<string, unknown> | undefined;
      const name = (fn?.name as string | undefined) ?? "";
      // Defensive: skip tool calls with missing/empty names (some models generate
      // malformed tool calls). Mirrors cc-switch behavior.
      if (name.trim().length === 0) continue;
      output.push({
        type: "function_call",
        id: toolCall.id as string | undefined,
        call_id: toolCall.id as string | undefined,
        name,
        arguments: fn?.arguments as string | undefined,
      });
    }
  }

  if (content !== undefined && (!Array.isArray(content) || content.length > 0)) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    if (text) {
      output.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
    }
  }

  return {
    id: chatResponse.id ?? "resp_0",
    object: "response",
    created_at: chatResponse.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: originalBody.model,
    output,
    usage: translateUsage(chatResponse.usage as Record<string, unknown> | undefined),
  };
}

export function translateUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!usage) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
  }

  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
  const cachedTokens =
    promptDetails.cached_tokens ??
    inputDetails.cached_tokens ??
    usage.cached_tokens ??
    0;

  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  const reasoningTokens =
    completionDetails.reasoning_tokens ??
    outputDetails.reasoning_tokens ??
    0;

  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    input_tokens_details: {
      ...promptDetails,
      ...inputDetails,
      cached_tokens: cachedTokens,
    },
    output_tokens_details: {
      ...completionDetails,
      ...outputDetails,
      reasoning_tokens: reasoningTokens,
    },
  };
}

function createResponseObject(
  responseId: string,
  model: string,
  createdAt: number,
  status: string,
  usage: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output: [],
    usage,
  };
}

function createAssistantItem(itemId: string, status: string, text: string): Record<string, unknown> {
  return {
    id: itemId,
    type: "message",
    role: "assistant",
    status,
    content: text ? [{ type: "output_text", text }] : [],
  };
}

function createOutputTextPart(text: string): Record<string, unknown> {
  return { type: "output_text", text: text ?? "" };
}

function createReasoningItem(itemId: string, status: string, summaryText = ""): Record<string, unknown> {
  return {
    id: itemId,
    type: "reasoning",
    status,
    summary: [{ type: "summary_text", text: summaryText }],
  };
}

function createSummaryTextPart(text: string): Record<string, unknown> {
  return { type: "summary_text", text: text ?? "" };
}

/**
 * Allocates the next output index for this response and returns it.
 * Output indices must be unique per output item (text, reasoning, function_call,
 * etc.) in the order they first appear.
 */
function allocateOutputIndex(ctx: { state: Record<string, unknown> }): number {
  const next = (ctx.state.nextOutputIndex as number) ?? 0;
  ctx.state.nextOutputIndex = next + 1;
  return next;
}

/**
 * Translates a Chat Completions SSE chunk into the OpenAI Responses API event
 * sequence that Codex CLI expects.
 */
export function translateChatStreamChunkToResponses(
  ctx: { state: Record<string, unknown> },
  chunk: Record<string, unknown>,
  originalBody: Record<string, unknown>,
): Record<string, unknown>[] {
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0];
  const responseId = (chunk.id as string) ?? "resp_0";
  const textItemId = `${responseId}_item`;
  const reasoningItemId = `${responseId}_reasoning`;
  const model = (originalBody.model as string) ?? "";
  const createdAt = (chunk.created as number) ?? Math.floor(Date.now() / 1000);

  let accumulatedText = (ctx.state.accumulatedText as string) ?? "";
  let accumulatedReasoning = (ctx.state.accumulatedReasoning as string) ?? "";
  const accumulatedToolCalls = (ctx.state.accumulatedToolCalls as Record<number, Record<string, unknown>>) ?? {};

  // Usage-only chunk at the end of the stream: emit completion if we have not already done so.
  if (!firstChoice && chunk.usage !== undefined) {
    if (ctx.state.completedEmitted) return [];
    ctx.state.completedEmitted = true;
    return [
      {
        type: "response.completed",
        response: createResponseObject(responseId, model, createdAt, "completed", translateUsage(chunk.usage as Record<string, unknown>)),
      },
    ];
  }

  if (!firstChoice) return [];

  const delta = firstChoice.delta as Record<string, unknown> | undefined;
  const finishReason = firstChoice.finish_reason as string | undefined;
  const events: Record<string, unknown>[] = [];

  // Some providers omit the role on the first delta, so treat any assistant-like
  // content (text, reasoning, or tool calls) as the start of the response.
  const isAssistantDelta =
    delta?.role === "assistant" ||
    typeof delta?.content === "string" ||
    typeof delta?.reasoning_content === "string" ||
    (Array.isArray(delta?.tool_calls) && (delta.tool_calls as Array<Record<string, unknown>>).length > 0);

  if (isAssistantDelta && !ctx.state.responseCreatedEmitted) {
    ctx.state.responseCreatedEmitted = true;
    events.push({
      type: "response.created",
      response: createResponseObject(responseId, model, createdAt, "in_progress", null),
    });
  }

  // Reasoning delta for thinking-style models (Kimi/Qwen). Preserve it as a
  // Responses API reasoning item rather than dropping it.
  const reasoningText = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
  if (reasoningText) {
    if (!ctx.state.reasoningOutputItemAdded) {
      ctx.state.reasoningOutputItemAdded = true;
      const outputIndex = allocateOutputIndex(ctx);
      ctx.state.reasoningOutputIndex = outputIndex;
      events.push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: createReasoningItem(reasoningItemId, "in_progress"),
      });
      events.push({
        type: "response.reasoning_summary_part.added",
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: 0,
        part: createSummaryTextPart(""),
      });
    }
    const outputIndex = ctx.state.reasoningOutputIndex as number;
    accumulatedReasoning += reasoningText;
    ctx.state.accumulatedReasoning = accumulatedReasoning;
    events.push({
      type: "response.reasoning_summary_text.delta",
      item_id: reasoningItemId,
      output_index: outputIndex,
      summary_index: 0,
      delta: reasoningText,
    });
  }

  // Text delta for the assistant message.
  const text = typeof delta?.content === "string" ? delta.content : "";
  if (text) {
    if (!ctx.state.textOutputItemAdded) {
      ctx.state.textOutputItemAdded = true;
      const outputIndex = allocateOutputIndex(ctx);
      ctx.state.textOutputIndex = outputIndex;
      events.push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: createAssistantItem(textItemId, "in_progress", ""),
      });
    }
    const outputIndex = ctx.state.textOutputIndex as number;
    accumulatedText += text;
    ctx.state.accumulatedText = accumulatedText;
    events.push({
      type: "response.output_text.delta",
      item_id: textItemId,
      output_index: outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  // Tool call deltas are emitted incrementally by Kimi. Accumulate them and
  // translate to Responses API function_call events.
  //
  // Defensive: some upstream models emit tool_call deltas without a valid
  // function name. We defer output_item.added until a non-empty name arrives;
  // if the stream ends before that happens, the call is dropped and the
  // response is failed when no usable tool call remains (mirrors cc-switch).
  const toolCallsDelta = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCallsDelta && toolCallsDelta.length > 0) {
    for (const toolCall of toolCallsDelta) {
      const chatIndex = (toolCall.index as number) ?? 0;
      const existing = accumulatedToolCalls[chatIndex] ?? {};
      const toolCallId = (toolCall.id as string) ?? (existing.id as string) ?? `${responseId}_tool_${chatIndex}`;
      const fn = toolCall.function as Record<string, unknown> | undefined;
      const nameDelta = (fn?.name as string) ?? "";
      const name = nameDelta || ((existing.name as string | undefined) ?? "");
      const argsDelta = fn?.arguments as string | undefined;

      let outputIndex: number;
      if (typeof existing.outputIndex === "number") {
        outputIndex = existing.outputIndex;
      } else {
        outputIndex = allocateOutputIndex(ctx);
      }

      accumulatedToolCalls[chatIndex] = {
        id: toolCallId,
        name,
        arguments: (existing.arguments as string | undefined ?? "") + (argsDelta ?? ""),
        outputIndex,
        added: (existing.added as boolean | undefined) ?? false,
      };

      // Only announce the tool call once we have a usable name.
      const addedKey = `toolCallAddedEmitted_${chatIndex}`;
      if (!ctx.state[addedKey] && name.trim().length > 0) {
        ctx.state[addedKey] = true;
        accumulatedToolCalls[chatIndex].added = true;
        events.push({
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            type: "function_call",
            id: toolCallId,
            call_id: toolCallId,
            name,
            arguments: accumulatedToolCalls[chatIndex].arguments,
            status: "in_progress",
          },
        });
      }

      if (argsDelta && name.trim().length > 0) {
        events.push({
          type: "response.function_call_arguments.delta",
          item_id: toolCallId,
          output_index: outputIndex,
          call_id: toolCallId,
          delta: argsDelta,
        });
      }
    }
    ctx.state.accumulatedToolCalls = accumulatedToolCalls;
  }

  // Finish reason means the output item(s) and response are complete.
  if (finishReason) {
    // Tool calls: emit done events sorted by the output_index they were assigned.
    // Skip any call that never received a valid name.
    const sortedToolCalls = Object.values(accumulatedToolCalls).sort(
      (a, b) => (a.outputIndex as number) - (b.outputIndex as number),
    );
    const usableToolCalls = sortedToolCalls.filter(
      (tc) => typeof tc.name === "string" && tc.name.trim().length > 0 && tc.added,
    );
    const droppedToolCalls = sortedToolCalls.length - usableToolCalls.length;

    if (usableToolCalls.length > 0) {
      for (const toolCall of usableToolCalls) {
        const outputIndex = toolCall.outputIndex as number;
        const toolCallId = (toolCall.id as string) ?? `${responseId}_tool_${outputIndex}`;
        events.push({
          type: "response.function_call_arguments.done",
          item_id: toolCallId,
          output_index: outputIndex,
          call_id: toolCallId,
          arguments: toolCall.arguments,
        });
        events.push({
          type: "response.output_item.done",
          output_index: outputIndex,
          item: {
            type: "function_call",
            id: toolCallId,
            call_id: toolCallId,
            name: toolCall.name,
            arguments: toolCall.arguments,
            status: "completed",
          },
        });
      }
    }

    // If every tool call was dropped and the upstream signaled completion via
    // tool_calls, fail the response rather than returning a confusing empty
    // completed response (cc-switch behavior).
    if (droppedToolCalls > 0 && usableToolCalls.length === 0 && finishReason === "tool_calls") {
      ctx.state.completedEmitted = true;
      return [
        ...events,
        {
          type: "response.failed",
          response: {
            error: {
              message: `Upstream returned ${droppedToolCalls} tool call(s) without a function name, leaving no usable tool call in this turn`,
              type: "upstream_tool_call_dropped",
            },
          },
        },
      ];
    }

    if (ctx.state.reasoningOutputItemAdded) {
      const outputIndex = ctx.state.reasoningOutputIndex as number;
      events.push({
        type: "response.reasoning_summary_text.done",
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: 0,
        text: accumulatedReasoning,
      });
      events.push({
        type: "response.reasoning_summary_part.done",
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: 0,
        part: createSummaryTextPart(accumulatedReasoning),
      });
      events.push({
        type: "response.output_item.done",
        output_index: outputIndex,
        item: createReasoningItem(reasoningItemId, "completed"),
      });
    }

    if (ctx.state.textOutputItemAdded) {
      const outputIndex = ctx.state.textOutputIndex as number;
      events.push({
        type: "response.output_text.done",
        item_id: textItemId,
        output_index: outputIndex,
        content_index: 0,
        text: accumulatedText,
      });
      events.push({
        type: "response.content_part.done",
        item_id: textItemId,
        output_index: outputIndex,
        content_index: 0,
        part: createOutputTextPart(accumulatedText),
      });
      events.push({
        type: "response.output_item.done",
        output_index: outputIndex,
        item: createAssistantItem(textItemId, "completed", accumulatedText),
      });
    }

    // Kimi puts usage inside the final choice, not as a separate chunk.
    const finishUsage = (chunk.usage ?? firstChoice?.usage) as Record<string, unknown> | undefined;
    if (!ctx.state.completedEmitted) {
      ctx.state.completedEmitted = true;
      events.push({
        type: "response.completed",
        response: createResponseObject(
          responseId,
          model,
          createdAt,
          "completed",
          finishUsage !== undefined ? translateUsage(finishUsage) : null,
        ),
      });
    }
  }

  return events;
}

export function createResponsesDoneChunk(usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      status: "completed",
      usage: translateUsage(usage),
    },
  };
}
