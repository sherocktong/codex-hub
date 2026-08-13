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
  upstreamBody.messages = input ? input.map(translateInputItem) : [];

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
  let role = typeof item.role === "string" ? item.role : "user";
  // OpenAI's Responses API uses 'developer' for system instructions; Kimi/Qianwen only accept 'system'.
  if (role === "developer") role = "system";

  if (item.type === "message" || item.type === undefined) {
    const content = item.content;
    return { role, content: translateContent(content) };
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

  const output: Array<Record<string, unknown>> = [];
  if (content !== undefined) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: typeof content === "string" ? content : JSON.stringify(content) }],
    });
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

function translateUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    input_tokens_details: usage.prompt_tokens_details,
    output_tokens_details: usage.completion_tokens_details,
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
): Record<string, unknown>[] | undefined {
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0];
  const responseId = (chunk.id as string) ?? "resp_0";
  const itemId = `${responseId}_item`;
  const partId = `${itemId}_part_0`;
  const model = (originalBody.model as string) ?? "";
  const createdAt = (chunk.created as number) ?? Math.floor(Date.now() / 1000);

  let accumulatedText = (ctx.state.accumulatedText as string) ?? "";

  // Usage-only chunk at the end of the stream: emit completion if we have not already done so.
  if (!firstChoice && chunk.usage !== undefined) {
    if (ctx.state.completedEmitted) return undefined;
    ctx.state.completedEmitted = true;
    return [
      {
        type: "response.completed",
        response: createResponseObject(responseId, model, createdAt, "completed", translateUsage(chunk.usage as Record<string, unknown>)),
      },
    ];
  }

  if (!firstChoice) return undefined;

  const delta = firstChoice.delta as Record<string, unknown> | undefined;
  const finishReason = firstChoice.finish_reason as string | undefined;
  const events: Record<string, unknown>[] = [];

  // The first assistant delta marks the start of the response and its first output item.
  if (delta?.role === "assistant") {
    events.push({
      type: "response.created",
      response: createResponseObject(responseId, model, createdAt, "in_progress", null),
    });
    events.push({
      type: "response.output_item.added",
      output_index: 0,
      item: createAssistantItem(itemId, "in_progress", ""),
    });
  }

  // Text delta for the assistant message.
  const text = typeof delta?.content === "string" ? delta.content : "";
  if (text) {
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

  // Finish reason means the output text/item/response is complete.
  if (finishReason) {
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
    if (!ctx.state.completedEmitted) {
      ctx.state.completedEmitted = true;
      events.push({
        type: "response.completed",
        response: createResponseObject(responseId, model, createdAt, "completed", null),
      });
    }
  }

  return events.length > 0 ? events : undefined;
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
