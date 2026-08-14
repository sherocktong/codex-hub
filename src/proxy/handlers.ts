import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readBody, sendJson, sendError } from "./server.js";
import { createForwarder } from "./forwarder.js";
import * as logger from "../logger.js";
import type { ProxyInstanceConfig, ProviderAdapter, RequestContext } from "./types.js";
import { parseSseBlock, serializeSseBlock, splitSseBlocks, appendUtf8Safe } from "./sse.js";
import { getAdapter } from "./providers/index.js";
import { logRequest } from "./usage.js";

export function createRequestHandler(config: ProxyInstanceConfig) {
  const forwarder = createForwarder(config.profileName, config.providers[0]);
  const wss = new WebSocketServer({ noServer: true });

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

    if (
      req.headers.upgrade === "websocket" &&
      (url === "/v1/responses" || url === "/v1/chat/completions")
    ) {
      handleWebSocketUpgrade(wss, req, config, forwarder);
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

function handleWebSocketUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  config: ProxyInstanceConfig,
  forwarder: ReturnType<typeof createForwarder>,
): void {
  wss.handleUpgrade(req, req.socket, Buffer.alloc(0), async (ws) => {
    const url = req.url || "/";
    const method = "POST";

    ws.once("message", async (data) => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(data.toString("utf-8")) as Record<string, unknown>;
      } catch {
        sendWsError(ws, 400, "invalid JSON", "invalid_request_error");
        ws.close();
        return;
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === "upgrade" || key.toLowerCase() === "connection") continue;
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
      headers.set("Content-Type", "application/json");

      const sessionId = req.headers["x-codex-session-id"] as string | undefined;

      try {
        const { response, provider, ctx } = await forwarder.forward(
          new Request(`http://${req.headers.host}${url}`, {
            method,
            headers,
            body: JSON.stringify(body),
          }),
          body,
          url,
          method,
          headers,
          sessionId,
        );

        const adapter = getAdapter(provider);

        if (body.stream && response.body) {
          await logRequest(ctx, response);
          await pipeWebSocketStream(ws, response.body, adapter, ctx);
        } else {
          await logRequest(ctx, response);
          const resBody = await response.arrayBuffer();
          ws.send(Buffer.from(resBody));
        }

        ws.close();
      } catch (err) {
        logger.error("Proxy WebSocket forwarding error", err);
        sendWsError(ws, 502, err instanceof Error ? err.message : String(err), "proxy_error");
        ws.close();
      }
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", err);
    });
  });
}

function sendWsError(ws: WebSocket, status: number, message: string, type: string): void {
  ws.send(JSON.stringify({ error: { type, message, status } }));
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
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("stream transform error", err);
          res.write(
            serializeSseBlock({
              data: JSON.stringify({
                type: "response.failed",
                response: {
                  error: {
                    message: `Stream transform error: ${message}`,
                    type: "proxy_error",
                  },
                },
              }),
            }),
          );
          res.end();
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

async function pipeWebSocketStream(
  ws: WebSocket,
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
        if (fields.data === undefined) continue;
        if (fields.data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(fields.data) as Record<string, unknown>;
          const transformed = adapter.transformStreamChunk
            ? adapter.transformStreamChunk(ctx, parsed)
            : parsed;
          const events = Array.isArray(transformed) ? transformed : [transformed];
          for (const event of events) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(event));
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("WebSocket stream transform error", err);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "response.failed",
                response: {
                  error: {
                    message: `Stream transform error: ${message}`,
                    type: "proxy_error",
                  },
                },
              }),
            );
          }
          ws.close();
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
}
