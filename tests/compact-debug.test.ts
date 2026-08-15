import http from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { startProxyServer } from "../src/proxy/server.js";
import { createRequestHandler } from "../src/proxy/handlers.js";
import type { ProxyInstanceConfig } from "../src/proxy/types.js";

describe("compact debug", () => {
  let proxyServer: Awaited<ReturnType<typeof startProxyServer>> | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    if (proxyServer) {
      await proxyServer.stop();
      proxyServer = undefined;
    }
    if (upstream) {
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
      upstream = undefined;
    }
  });

  it("logs upstream request", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        capturedBody = JSON.parse(body);
        console.log("UPSTREAM", req.url, JSON.stringify(capturedBody, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-compact",
          object: "chat.completion",
          model: "kimi-k2-5-coding",
          choices: [{ message: { role: "assistant", content: "Summary" } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
      });
    });

    const upstreamPort = await new Promise<number>((resolve) => {
      upstream!.listen(0, "127.0.0.1", () => {
        resolve((upstream!.address() as { port: number }).port);
      });
    });

    const config: ProxyInstanceConfig = {
      profileName: "test",
      port: 0,
      listenAddress: "127.0.0.1",
      providers: [{
        id: "kimi",
        type: "kimi",
        name: "Kimi",
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: "test-key",
        models: ["kimi-k2-5-coding"],
        responsesToChatCompletions: true,
      }],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/responses/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client" },
      body: JSON.stringify({
        model: "kimi-k2.7",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Plan a trip." }] }],
      }),
    });

    console.log("PROXY STATUS", response.status);
    console.log("PROXY BODY", await response.text());
    expect(capturedBody).toBeDefined();
  });
});
