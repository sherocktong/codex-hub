/**
 * Translates OpenAI Responses API requests/responses to Chat Completions format.
 *
 * Kimi and Qianwen expose OpenAI-compatible Chat Completions but not the newer
 * Responses API. Codex CLI's default `wire_api = "responses"` sends requests to
 * /v1/responses, so the proxy must translate them to /v1/chat/completions.
 */

import type { ProviderConfig } from "../types.js";

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

  const input = body.input as Array<Record<string, unknown>> | undefined;
  upstreamBody.messages = Array.isArray(input) ? input.map(translateInputItem) : [];

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

  // Convert tools from Responses API format to Chat Completions format.
  if (body.tools) {
    upstreamBody.tools = convertTools(body.tools as Array<Record<string, unknown>>);
  }
  if (body.tool_choice !== undefined) {
    upstreamBody.tool_choice = convertToolChoice(body.tool_choice as string | Record<string, unknown>);
  }

  // Normalize model to a provider-supported model id.
  upstreamBody.model = normalizeModel(upstreamBody.model as string | undefined, provider);

  return {
    upstreamPath: "/v1/chat/completions",
    upstreamBody,
    originalBody: body,
  };
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

    // Preserve tool_calls for assistant messages; Kimi accepts empty-string content
    // as long as tool_calls are present and followed by tool messages.
    if (item.tool_calls) {
      translated.tool_calls = item.tool_calls;
    }

    const translatedContent = translateContent(content);
    // Kimi rejects messages whose content is an empty array or empty string
    // ("must not be empty"). Use a single zero-width space as a harmless filler.
    if (
      (Array.isArray(translatedContent) && translatedContent.length === 0) ||
      translatedContent === ""
    ) {
      translated.content = "​";
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
      output.push({
        type: "function_call",
        id: toolCall.id as string | undefined,
        call_id: toolCall.id as string | undefined,
        name: fn?.name as string | undefined,
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
  const itemId = `${responseId}_item`;
  const model = (originalBody.model as string) ?? "";
  const createdAt = (chunk.created as number) ?? Math.floor(Date.now() / 1000);

  let accumulatedText = (ctx.state.accumulatedText as string) ?? "";
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

  // The first assistant delta marks the start of the response. We deliberately do
  // not add an output item here; we wait until we know whether the model is
  // emitting text or a function call.
  if (delta?.role === "assistant" && !ctx.state.responseCreatedEmitted) {
    ctx.state.responseCreatedEmitted = true;
    events.push({
      type: "response.created",
      response: createResponseObject(responseId, model, createdAt, "in_progress", null),
    });
  }

  // Text delta for the assistant message.
  const text = typeof delta?.content === "string" ? delta.content : "";
  if (text) {
    if (!ctx.state.textOutputItemAdded) {
      ctx.state.textOutputItemAdded = true;
      events.push({
        type: "response.output_item.added",
        output_index: 0,
        item: createAssistantItem(itemId, "in_progress", ""),
      });
    }
    accumulatedText += text;
    ctx.state.accumulatedText = accumulatedText;
    events.push({
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
  }

  // Tool call deltas are emitted incrementally by Kimi. Accumulate them and
  // translate to Responses API function_call events.
  const toolCallsDelta = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCallsDelta && toolCallsDelta.length > 0) {
    for (const toolCall of toolCallsDelta) {
      const index = (toolCall.index as number) ?? 0;
      const existing = accumulatedToolCalls[index] ?? {};
      const toolCallId = (toolCall.id as string) ?? (existing.id as string) ?? `${responseId}_tool_${index}`;
      const fn = toolCall.function as Record<string, unknown> | undefined;
      const name = (fn?.name as string) ?? (existing.name as string);
      const argsDelta = fn?.arguments as string | undefined;

      accumulatedToolCalls[index] = {
        id: toolCallId,
        name,
        arguments: (existing.arguments as string | undefined ?? "") + (argsDelta ?? ""),
      };

      const addedKey = `toolCallAddedEmitted_${index}`;
      if (!ctx.state[addedKey]) {
        ctx.state[addedKey] = true;
        events.push({
          type: "response.output_item.added",
          output_index: index,
          item: {
            type: "function_call",
            id: toolCallId,
            call_id: toolCallId,
            name,
            arguments: accumulatedToolCalls[index].arguments,
            status: "in_progress",
          },
        });
      }

      if (argsDelta) {
        events.push({
          type: "response.function_call_arguments.delta",
          item_id: toolCallId,
          output_index: index,
          call_id: toolCallId,
          delta: argsDelta,
        });
      }
    }
    ctx.state.accumulatedToolCalls = accumulatedToolCalls;
  }

  // Finish reason means the output item(s) and response are complete.
  if (finishReason) {
    if (finishReason === "tool_calls" || Object.keys(accumulatedToolCalls).length > 0) {
      for (const [indexStr, toolCall] of Object.entries(accumulatedToolCalls)) {
        const index = Number(indexStr);
        const toolCallId = (toolCall.id as string) ?? `${responseId}_tool_${index}`;
        events.push({
          type: "response.function_call_arguments.done",
          item_id: toolCallId,
          output_index: index,
          call_id: toolCallId,
          arguments: toolCall.arguments,
        });
        events.push({
          type: "response.output_item.done",
          output_index: index,
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
    } else if (ctx.state.textOutputItemAdded) {
      events.push({
        type: "response.output_text.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: accumulatedText,
      });
      events.push({
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: createOutputTextPart(accumulatedText),
      });
      events.push({
        type: "response.output_item.done",
        output_index: 0,
        item: createAssistantItem(itemId, "completed", accumulatedText),
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
