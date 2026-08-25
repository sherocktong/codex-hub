import type { ProviderAdapter, RequestContext } from "../types.js";
import { buildUpstreamUrl, mergeProviderHeaders, normalizeModel, shouldEnablePromptCacheRouting } from "./index.js";
import { injectCacheRouting } from "../cache-injector.js";
import * as logger from "../../logger.js";
import {
  shouldTranslateResponsesToChat,
  translateResponsesRequestToChat,
  translateChatResponseToResponses,
  translateChatStreamChunkToResponses,
  flushChatStreamToResponses,
} from "../responses-translator.js";

export const qianwenAdapter: ProviderAdapter = {
  type: "qianwen",
  name: "Qianwen",
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
      const translated = translateResponsesRequestToChat(body, ctx.provider, ctx);
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
      injectCacheRouting(upstreamBody, ctx);
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
        const translated = translateChatResponseToResponses(data, ctx.body, ctx);
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

  translateError: async (response: Response, _bodyText: string): Promise<Response | undefined> => {
    logger.debug(`translateError: status=${response.status} content-type=${response.headers.get("content-type")}`);
    if (response.status !== 400) return undefined;

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      logger.debug(`translateError: skipping non-JSON content-type=${contentType}`);
      return undefined;
    }

    let data: Record<string, unknown>;
    try {
      data = await response.clone().json();
    } catch (err) {
      logger.debug(`translateError: JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }

    const error = data.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === "string"
      ? error.message
      : typeof data.message === "string"
        ? data.message
        : "";
    logger.debug(`translateError: parsed message=${message.slice(0, 100)}`);
    const rangeMatch = message.match(/Range of input length should be \[(\d+),\s*(\d+)\]/i);
    if (!rangeMatch) {
      logger.debug(`translateError: no range match`);
      return undefined;
    }

    const maxLength = Number(rangeMatch[2]);
    const openAIError = {
      error: {
        message: `This model's maximum context length is ${maxLength} tokens. However, your messages resulted in more than ${maxLength} tokens.`,
        type: "context_length_exceeded",
        param: "messages",
        code: "context_length_exceeded",
      },
    };

    return new Response(JSON.stringify(openAIError), {
      status: 400,
      statusText: response.statusText,
      headers: { "Content-Type": "application/json" },
    });
  },

  transformStreamChunk(ctx: RequestContext, chunk: Record<string, unknown>): Record<string, unknown> | Record<string, unknown>[] {
    const translateResponses =
      shouldTranslateResponsesToChat(ctx.provider) &&
      (ctx.path === "/v1/responses" || ctx.path === "/v1/responses/compact");
    if (translateResponses) {
      return translateChatStreamChunkToResponses(ctx, chunk, ctx.body);
    }
    return chunk;
  },

  flushStream(ctx: RequestContext): Record<string, unknown> | Record<string, unknown>[] {
    const translateResponses =
      shouldTranslateResponsesToChat(ctx.provider) &&
      (ctx.path === "/v1/responses" || ctx.path === "/v1/responses/compact");
    if (translateResponses) {
      return flushChatStreamToResponses(ctx);
    }
    return [];
  },
};
