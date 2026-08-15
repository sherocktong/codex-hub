import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readBody, sendJson, sendError } from "./server.js";
import { createForwarder } from "./forwarder.js";
import * as logger from "../logger.js";
import type { ProxyInstanceConfig, ProviderAdapter, RequestContext } from "./types.js";
import { parseSseBlock, serializeSseBlock, splitSseBlocks, appendUtf8Safe } from "./sse.js";
import { translateResponsesRequestToChat, translateUsage } from "./responses-translator.js";
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

    if (method === "POST" && url === "/v1/responses/compact") {
      await handleCompactRequest(req, res, forwarder);
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

const COMPACT_SYSTEM_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Read the full conversation history below, then write a dense, self-contained summary that preserves:
- The user's original goal and any constraints or requirements
- Key decisions, discoveries, and conclusions so far
- Important file paths, code snippets, commands, and their outputs
- The current plan and next steps
- Any pending or in-progress work

The summary should be concise but complete enough that another instance of the assistant can continue without re-reading the original history.`;

async function handleCompactRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  forwarder: ReturnType<typeof createForwarder>,
): Promise<void> {
  const rawBody = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    sendError(res, 400, "invalid JSON", "invalid_request_error");
    return;
  }

  const input = body.input as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(input) || input.length === 0) {
    sendError(res, 400, "compact request must contain a non-empty input array", "invalid_request_error");
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

  const compactBody: Record<string, unknown> = {
    model: body.model,
    input: [
      { type: "message", role: "developer", content: COMPACT_SYSTEM_PROMPT },
      ...input,
      {
        type: "message",
        role: "user",
        content: "Produce the context checkpoint compaction summary now.",
      },
    ],
    stream: false,
  };

  const sessionId = req.headers["x-codex-session-id"] as string | undefined;

  try {
    const { response, ctx } = await forwarder.forward(
      new Request(`http://${req.headers.host}/v1/responses/compact`, {
        method: "POST",
        headers,
        body: JSON.stringify(compactBody),
      }),
      compactBody,
      "/v1/responses/compact",
      "POST",
      headers,
      sessionId,
    );

    await logRequest(ctx, response);

    const chatData = await response.json() as Record<string, unknown>;
    const assistantText = extractAssistantText(chatData);

    const compactResponse = {
      id: `resp_compact_${generateId()}`,
      object: "response.compaction",
      created_at: Math.floor(Date.now() / 1000),
      model: body.model,
      output: [
        {
          type: "compaction",
          encrypted_content: assistantText,
        },
      ],
      usage: translateUsage(chatData.usage as Record<string, unknown> | undefined),
    };

    sendJson(res, 200, compactResponse);
  } catch (err) {
    logger.error("Proxy compaction error", err);
    if (!res.headersSent) {
      sendError(res, 502, err instanceof Error ? err.message : String(err), "proxy_error");
    }
  }
}

function extractAssistantText(chatResponse: Record<string, unknown>): string {
  // The adapter may have already translated the upstream Chat Completions response
  // into the Responses API shape, so handle both formats.
  const output = chatResponse.output as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(output)) {
    const textParts: string[] = [];
    for (const item of output) {
      if (item.type !== "message" || item.role !== "assistant") continue;
      const content = item.content;
      if (typeof content === "string") {
        textParts.push(content);
        continue;
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part.text === "string") textParts.push(part.text);
        }
      }
    }
    return textParts.join("");
  }

  const choices = chatResponse.choices as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0];
  const message = firstChoice?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: Record<string, unknown>) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
        await sendWsError(ws, 400, "invalid JSON", "invalid_request_error");
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
          await new Promise<void>((resolve, reject) => {
            ws.send(Buffer.from(resBody), (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }

        ws.close();
      } catch (err) {
        logger.error("Proxy WebSocket forwarding error", err);
        const message = err instanceof Error ? err.message : String(err);
        await sendWsError(ws, 502, message, "proxy_error");
        ws.close();
      }
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", err);
    });
  });
}

async function sendWsError(ws: WebSocket, status: number, message: string, type: string): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;

  const payload = JSON.stringify({
    type: "response.failed",
    response: {
      error: {
        message,
        type,
        status,
      },
    },
  });

  return new Promise((resolve) => {
    ws.send(payload, (sendErr) => {
      if (sendErr) {
        logger.error("Failed to send WebSocket error", sendErr);
      }
      resolve();
    });
  });
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
  let clientClosed = false;

  const onClose = () => {
    clientClosed = true;
    reader.cancel().catch(() => {});
  };
  ws.once("close", onClose);

  try {
    while (!clientClosed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientClosed) break;

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
    ws.off("close", onClose);
    reader.releaseLock();
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
}
