import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import WebSocket from "ws";

const TEST_DIR = path.join(os.tmpdir(), `codx-websocket-test-${process.pid}`);
process.env.CODEX_HOME = TEST_DIR;
process.env.CODEX_DIR = TEST_DIR;
process.env.CODX_PROXY_CONFIG_DIR = TEST_DIR;
process.env.CODEX_PROFILES_FILE = path.join(TEST_DIR, "profiles.json");

const { startProxyServer } = await import("../src/proxy/server.js");
const { createRequestHandler } = await import("../src/proxy/handlers.js");
const { getDefaultProviderPresets, writeProvidersConfig } = await import("../src/proxy/config.js");

describe("websocket proxy", () => {
  let server: Awaited<ReturnType<typeof startProxyServer>>;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(TEST_DIR, "profiles.json"),
      JSON.stringify({ profiles: { test: { provider: "kimi", model: "kimi-k2.7" } } }, null, 2),
      "utf-8",
    );

    writeProvidersConfig(getDefaultProviderPresets());

    const handler = createRequestHandler({
      profileName: "test",
      port: 0,
      listenAddress: "127.0.0.1",
      providers: [{
        id: "kimi",
        type: "kimi",
        name: "Kimi",
        baseUrl: "https://api.kimi.com/coding",
        apiKey: "",
        models: ["kimi-k2.7"],
        responsesToChatCompletions: true,
      }],
      requestTimeout: 120_000,
      maxRetries: 1,
      streamingFirstByteTimeout: 30_000,
      streamingIdleTimeout: 60_000,
      nonStreamingTimeout: 120_000,
    });

    server = await startProxyServer(0, "127.0.0.1", handler);
  });

  afterEach(async () => {
    await server.stop();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("accepts WebSocket upgrades on /v1/responses", async () => {
    const ws = new WebSocket(`ws://${server.baseUrl.replace("http://", "")}/v1/responses`);

    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("websocket open timeout")), 5000);
    });

    await opened;
    ws.close();
  });

  it("handles multiple messages over a single persistent WebSocket", async () => {
    await server.stop();

    let requestCount = 0;
    const upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requestCount++;
        const parsed = JSON.parse(body);
        expect(parsed.messages).toEqual([{ role: "user", content: "​" }]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `chatcmpl-${requestCount}`,
            object: "chat.completion",
            model: parsed.model,
            choices: [{ message: { role: "assistant", content: `Reply ${requestCount}` } }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
      });
    });

    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        resolve((upstream.address() as { port: number }).port);
      });
    });

    const handler = createRequestHandler({
      profileName: "test",
      port: 0,
      listenAddress: "127.0.0.1",
      providers: [{
        id: "kimi",
        type: "kimi",
        name: "Kimi",
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: "",
        models: ["kimi-k2.7"],
        responsesToChatCompletions: true,
      }],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    });

    server = await startProxyServer(0, "127.0.0.1", handler);

    const ws = new WebSocket(`ws://${server.baseUrl.replace("http://", "")}/v1/responses`);

    const messages: WebSocket.RawData[] = [];
    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("websocket open timeout")), 5000);
    });

    ws.on("message", (data) => messages.push(data));

    await opened;

    const firstResponse = new Promise<void>((resolve) => {
      const check = () => {
        if (messages.length >= 1) {
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    ws.send(JSON.stringify({ model: "kimi-k2.7", input: [] }));
    await firstResponse;

    const secondResponse = new Promise<void>((resolve) => {
      const check = () => {
        if (messages.length >= 2) {
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    ws.send(JSON.stringify({ model: "kimi-k2.7", input: [] }));
    await secondResponse;

    ws.close();
    await new Promise<void>((resolve) => ws.on("close", resolve));
    upstream.close();

    expect(messages.length).toBe(2);
    const first = JSON.parse(messages[0].toString("utf-8"));
    const second = JSON.parse(messages[1].toString("utf-8"));
    expect(first.object).toBe("response");
    expect(first.output[0].content[0].text).toBe("Reply 1");
    expect(second.object).toBe("response");
    expect(second.output[0].content[0].text).toBe("Reply 2");
  });

  it("emits a response.failed event when upstream returns an error", async () => {
    await server.stop();

    const upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        expect(parsed.messages).toEqual([{ role: "user", content: "​" }]);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }));
      });
    });

    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        resolve((upstream.address() as { port: number }).port);
      });
    });

    const handler = createRequestHandler({
      profileName: "test",
      port: 0,
      listenAddress: "127.0.0.1",
      providers: [{
        id: "kimi",
        type: "kimi",
        name: "Kimi",
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: "",
        models: ["kimi-k2.7"],
        responsesToChatCompletions: true,
      }],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    });

    server = await startProxyServer(0, "127.0.0.1", handler);

    const ws = new WebSocket(`ws://${server.baseUrl.replace("http://", "")}/v1/responses`);

    const messages: WebSocket.RawData[] = [];
    const closed = new Promise<void>((resolve) => {
      ws.on("close", resolve);
    });

    ws.on("message", (data) => messages.push(data));
    ws.on("open", () => {
      ws.send(JSON.stringify({ model: "kimi-k2.7", input: [] }));
    });

    await closed;
    upstream.close();

    expect(messages.length).toBeGreaterThan(0);
    const lastMessage = JSON.parse(messages[messages.length - 1].toString("utf-8"));
    expect(lastMessage.type).toBe("response.failed");
    expect(lastMessage.response.error.type).toBe("upstream_error");
    expect(lastMessage.response.error.message).toContain("bad request");
  });
});
