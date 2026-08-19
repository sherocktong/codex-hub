import type { ProviderAdapter, RequestContext } from "../types.js";
import { buildUpstreamUrl, mergeProviderHeaders, normalizeModel, shouldEnablePromptCacheRouting } from "./index.js";
import { injectPromptCacheKey } from "../cache-key.js";
import * as logger from "../../logger.js";
import {
  shouldTranslateResponsesToChat,
  translateResponsesRequestToChat,
  translateChatResponseToResponses,
  translateChatStreamChunkToResponses,
} from "../responses-translator.js";

export const kimiAdapter: ProviderAdapter = {
  type: "kimi",
  name: "Kimi",
  supportsPromptCacheRouting: true,

  async transformRequest(ctx: RequestContext): Promise<Request> {
    const body = { ...ctx.body };
    body.model = normalizeModel(body, ctx.provider);

    let upstreamPath = ctx.path;
    let upstreamBody = body;
    const translateResponses =
      shouldTranslateResponsesToChat(ctx.provider) &&
      (ctx.path === "/v1/responses" || ctx.path === "/v1/responses/compact");
    if (translateResponses) {
      const translated = translateResponsesRequestToChat(body, ctx.provider);
      upstreamPath = translated.upstreamPath;
      upstreamBody = translated.upstreamBody;
    }

    const headers = new Headers(ctx.headers);
    headers.set("Authorization", `Bearer ${ctx.provider.apiKey}`);
    headers.set("Content-Type", "application/json");
    headers.set("User-Agent", "codx/0.1.0");
    headers.delete("host");
    headers.delete("content-length");
    mergeProviderHeaders(headers, ctx.provider);

    if (shouldEnablePromptCacheRouting(ctx.provider)) {
      injectPromptCacheKey(upstreamBody, ctx);
    }

    const upstreamUrl = buildUpstreamUrl(ctx.provider, upstreamPath);
    return new Request(upstreamUrl, {
      method: ctx.method,
      headers,
      body: JSON.stringify(upstreamBody),
    });
  },

  async transformResponse(ctx: RequestContext, response: Response): Promise<Response> {
    const translateResponses =
      shouldTranslateResponsesToChat(ctx.provider) &&
      (ctx.path === "/v1/responses" || ctx.path === "/v1/responses/compact");
    if (translateResponses) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await response.json();
        const translated = translateChatResponseToResponses(data, ctx.body);
        return new Response(JSON.stringify(translated), {
          status: response.status,
          statusText: response.statusText,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const newHeaders = new Headers(response.headers);
    newHeaders.delete("content-encoding");
    newHeaders.delete("content-length");
    newHeaders.delete("transfer-encoding");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },

  translateError: async (response: Response, bodyText: string): Promise<Response | undefined> => {
    logger.debug(`translateError: status=${response.status} content-type=${response.headers.get("content-type")}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      logger.debug(`translateError: skipping non-JSON content-type=${contentType}`);
      return undefined;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      logger.debug(`translateError: JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }

    const error = (data.error as Record<string, unknown>) ?? data;
    const message = typeof error.message === "string"
      ? error.message
      : typeof data.message === "string"
        ? data.message
        : "";
    logger.debug(`translateError: parsed message=${message.slice(0, 100)}`);

    if (
      response.status === 400 &&
      /(context length|maximum context length|token limit|too many tokens|input length)/i.test(message)
    ) {
      const match = message.match(/(\d+)\s*tokens?/i);
      const maxLength = match ? Number(match[1]) : 0;
      return new Response(
        JSON.stringify({
          error: {
            message: maxLength
              ? `This model's maximum context length is ${maxLength} tokens. However, your messages resulted in more than ${maxLength} tokens.`
              : `This model's maximum context length was exceeded.`,
            type: "context_length_exceeded",
            param: "messages",
            code: "context_length_exceeded",
          },
        }),
        { status: 400, statusText: response.statusText, headers: { "Content-Type": "application/json" } },
      );
    }

    if (response.status === 429 || /rate.limit/i.test(message)) {
      return new Response(
        JSON.stringify({
          error: {
            message: message || "Rate limit exceeded.",
            type: "rate_limit_exceeded",
            code: "rate_limit_exceeded",
          },
        }),
        { status: 429, statusText: response.statusText, headers: { "Content-Type": "application/json" } },
      );
    }

    return undefined;
  },

  transformStreamChunk(ctx: RequestContext, chunk: Record<string, unknown>): Record<string, unknown> | Record<string, unknown>[] {
    const translateResponses =
      shouldTranslateResponsesToChat(ctx.provider) &&
      (ctx.path === "/v1/responses" || ctx.path === "/v1/responses/compact");
    if (translateResponses) {
      return translateChatStreamChunkToResponses(ctx, chunk, ctx.body);
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    if (choices) {
      for (const choice of choices) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (delta?.reasoning_content) {
          (delta as Record<string, unknown>).reasoning = delta.reasoning_content;
        }
      }
    }
    return chunk;
  },
};
