import type { ProviderAdapter, RequestContext } from "../types.js";
import { buildUpstreamUrl, normalizeModel, shouldEnablePromptCacheRouting } from "./index.js";
import { injectCacheRouting } from "../cache-injector.js";
import {
  shouldTranslateResponsesToChat,
  translateResponsesRequestToChat,
  translateChatResponseToResponses,
  translateChatStreamChunkToResponses,
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

  transformStreamChunk(ctx: RequestContext, chunk: Record<string, unknown>): Record<string, unknown> | Record<string, unknown>[] {
    const translateResponses =
      shouldTranslateResponsesToChat(ctx.provider) &&
      (ctx.path === "/v1/responses" || ctx.path === "/v1/responses/compact");
    if (translateResponses) {
      return translateChatStreamChunkToResponses(ctx, chunk, ctx.body);
    }
    return chunk;
  },
};
