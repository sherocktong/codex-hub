import http from "node:http";
import { readBody, sendJson, sendError } from "./server.js";
import { createForwarder } from "./forwarder.js";
import * as logger from "../logger.js";
import type { ProxyInstanceConfig, ProviderAdapter, RequestContext } from "./types.js";
import { parseSseBlock, serializeSseBlock, splitSseBlocks, appendUtf8Safe } from "./sse.js";
import { getAdapter } from "./providers/index.js";
import { logRequest } from "./usage.js";

export function createRequestHandler(config: ProxyInstanceConfig) {
  const forwarder = createForwarder(config.profileName, config.providers[0]);

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = req.url || "/";
    const method = req.method || "GET";

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, { status: "ok", profile: config.profileName });
      return;
    }

    if (method === "GET" && url === "/v1/status") {
      sendJson(res, 200, {
        running: true,
        profile: config.profileName,
        port: config.port,
        address: config.listenAddress,
        providers: config.providers.map((p) => ({ id: p.id, name: p.name })),
      });
      return;
    }

    if (method === "GET" && url === "/v1/models") {
      const models = new Set<string>();
      for (const provider of config.providers) {
        for (const model of provider.models) {
          models.add(model);
        }
      }
      sendJson(res, 200, {
        object: "list",
        data: Array.from(models).map((id) => ({ id, object: "model" })),
      });
      return;
    }

    if (method === "POST" && (url === "/v1/responses" || url === "/v1/chat/completions")) {
      const rawBody = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        sendError(res, 400, "invalid JSON", "invalid_request_error");
        return;
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }

      const sessionId = req.headers["x-codex-session-id"] as string | undefined;

      try {
        const { response, provider, ctx } = await forwarder.forward(
          new Request(`http://${req.headers.host}${url}`, {
            method,
            headers,
            body: rawBody,
          }),
          body,
          url,
          method,
          headers,
          sessionId,
        );

        const isStream = !!body.stream;
        const adapter = getAdapter(provider);

        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

        if (isStream && response.body) {
          await logRequest(ctx, response);
          await pipeStream(res, response.body, adapter, ctx);
        } else {
          await logRequest(ctx, response);
          const resBody = await response.arrayBuffer();
          res.end(Buffer.from(resBody));
        }
      } catch (err) {
        logger.error("Proxy forwarding error", err);
        if (!res.headersSent) {
          sendError(res, 502, err instanceof Error ? err.message : String(err), "proxy_error");
        }
      }
      return;
    }

    sendError(res, 404, "endpoint not found", "not_found");
  };
}

async function pipeStream(
  res: http.ServerResponse,
  body: ReadableStream<Uint8Array>,
  adapter: ProviderAdapter,
  ctx: RequestContext,
): Promise<void> {
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer = appendUtf8Safe(buffer, Buffer.from(value));

      for (const { block, remaining } of splitSseBlocks(buffer)) {
        buffer = remaining;
        if (!block) continue;

        const fields = parseSseBlock(block);
        if (fields.data === undefined) {
          res.write(block + "\n\n");
          continue;
        }

        if (fields.data === "[DONE]") {
          res.write(serializeSseBlock({ data: "[DONE]" }));
          continue;
        }

        try {
          const parsed = JSON.parse(fields.data) as Record<string, unknown>;
          const transformed = adapter.transformStreamChunk
            ? adapter.transformStreamChunk(ctx, parsed)
            : parsed;
          const events = Array.isArray(transformed) ? transformed : [transformed];
          for (const event of events) {
            res.write(serializeSseBlock({ data: JSON.stringify(event) }));
          }
        } catch {
          // If we can't parse/transform, pass the raw data line through.
          res.write(serializeSseBlock({ data: fields.data }));
        }
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
