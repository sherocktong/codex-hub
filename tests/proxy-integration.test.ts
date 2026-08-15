import http from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { startProxyServer } from "../src/proxy/server.js";
import { createRequestHandler } from "../src/proxy/handlers.js";
import type { ProxyInstanceConfig } from "../src/proxy/types.js";

describe("proxy integration", () => {
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

  it("forwards a chat completion request to an upstream server", async () => {
    // Start a mock OpenAI-compatible upstream.
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        expect(parsed.model).toBe("kimi-k2");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "upstream",
            object: "chat.completion",
            model: parsed.model,
            choices: [{ message: { role: "assistant", content: "Hi from upstream" } }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
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
      providers: [
        {
          id: "kimi",
          type: "kimi",
          name: "Kimi",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "test-key",
          models: ["kimi-k2"],
        },
      ],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client" },
      body: JSON.stringify({ model: "kimi-k2", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Hi from upstream");
    expect(json.model).toBe("kimi-k2");
  });

  it("translates /v1/responses to /v1/chat/completions for providers that need it", async () => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        expect(req.url).toBe("/v1/chat/completions");
        expect(parsed.model).toBe("kimi-k2-5-coding");
        expect(parsed.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            model: parsed.model,
            choices: [{ message: { role: "assistant", content: "Hello from Kimi" } }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
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
      providers: [
        {
          id: "kimi",
          type: "kimi",
          name: "Kimi",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "test-key",
          models: ["kimi-k2-5-coding"],
          responsesToChatCompletions: true,
        },
      ],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client" },
      body: JSON.stringify({
        model: "kimi-k2.7",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.object).toBe("response");
    expect(json.output[0].content[0].text).toBe("Hello from Kimi");
  });

  it("injects prompt_cache_key into translated /v1/responses requests", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            model: "kimi-k2-5-coding",
            choices: [{ message: { role: "assistant", content: "Hello from Kimi" } }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
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
      providers: [
        {
          id: "kimi",
          type: "kimi",
          name: "Kimi",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "test-key",
          models: ["kimi-k2-5-coding"],
          responsesToChatCompletions: true,
          promptCacheRouting: "enabled",
        },
      ],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client", "x-codex-session-id": "session-123" },
      body: JSON.stringify({
        model: "kimi-k2.7",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.prompt_cache_key).toBe("session-123");
  });

  it("injects cache_control markers into translated /v1/responses for Qwen", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            model: "qwen-max",
            choices: [{ message: { role: "assistant", content: "Hello from Qwen" } }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
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
      providers: [
        {
          id: "qianwen",
          type: "qianwen",
          name: "Qianwen",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "test-key",
          models: ["qwen-max"],
          responsesToChatCompletions: true,
          promptCacheRouting: "enabled",
        },
      ],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client" },
      body: JSON.stringify({
        model: "qwen-max",
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: "You are helpful." }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.prompt_cache_key).toBeUndefined();
    const messages = capturedBody!.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toEqual([
      { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("honors disabled prompt cache routing for Qwen", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            model: "qwen-max",
            choices: [{ message: { role: "assistant", content: "Hello from Qwen" } }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
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
      providers: [
        {
          id: "qianwen",
          type: "qianwen",
          name: "Qianwen",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "test-key",
          models: ["qwen-max"],
          responsesToChatCompletions: true,
          promptCacheRouting: "disabled",
        },
      ],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client" },
      body: JSON.stringify({
        model: "qwen-max",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.prompt_cache_key).toBeUndefined();
    const messages = capturedBody!.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toEqual([{ type: "text", text: "hello" }]);
    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(content[0].cache_control).toBeUndefined();
  });

  it("terminates the stream when an SSE chunk cannot be parsed or transformed", async () => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // First a valid Chat Completions SSE chunk.
      res.write(
        "data: " +
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 1,
            model: "kimi-k2-5-coding",
            choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
          }) +
          "\n\n",
      );
      // Then a malformed chunk that will fail JSON.parse and must not be forwarded raw.
      res.write("data: this is not valid json\n\n");
      res.end();
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
      providers: [
        {
          id: "kimi",
          type: "kimi",
          name: "Kimi",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "test-key",
          models: ["kimi-k2-5-coding"],
          responsesToChatCompletions: true,
        },
      ],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client" },
      body: JSON.stringify({
        model: "kimi-k2.7",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    // The valid chunk should have been translated to a Responses API event.
    expect(text).toContain("response.output_text.delta");
    // The proxy should emit a response.failed event with a structured error.
    expect(text).toContain('"type":"response.failed"');
    expect(text).toContain("Stream transform error");
    // The malformed raw line must not have been forwarded.
    expect(text).not.toContain("this is not valid json");
  });

  it("compacts /v1/responses/compact into a response.compaction object", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        capturedBody = JSON.parse(body);
        expect(req.url).toBe("/v1/chat/completions");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-compact",
            object: "chat.completion",
            model: "kimi-k2-5-coding",
            choices: [{ message: { role: "assistant", content: "Summary of prior work" } }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }),
        );
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
      providers: [
        {
          id: "kimi",
          type: "kimi",
          name: "Kimi",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "test-key",
          models: ["kimi-k2-5-coding"],
          responsesToChatCompletions: true,
        },
      ],
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
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Plan a trip." }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sure, where?" }] },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.stream).toBe(false);
    const messages = capturedBody!.messages as Array<Record<string, unknown>>;
    expect(messages[0].role).toBe("system");
    expect(messages[messages.length - 1].content).toContain("Produce the context checkpoint compaction summary");

    const json = await response.json();
    expect(json.object).toBe("response.compaction");
    expect(json.output).toHaveLength(1);
    expect(json.output[0].type).toBe("compaction");
    expect(json.output[0].encrypted_content).toBe("Summary of prior work");
    expect(json.usage.input_tokens).toBe(10);
    expect(json.usage.output_tokens).toBe(4);
  });

  it("translates compaction items in /v1/responses input back into messages", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        capturedBody = JSON.parse(body);
        expect(req.url).toBe("/v1/chat/completions");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-resume",
            object: "chat.completion",
            model: "kimi-k2-5-coding",
            choices: [{ message: { role: "assistant", content: "Continuing from checkpoint" } }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        );
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
      providers: [
        {
          id: "kimi",
          type: "kimi",
          name: "Kimi",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "test-key",
          models: ["kimi-k2-5-coding"],
          responsesToChatCompletions: true,
        },
      ],
      requestTimeout: 5000,
      maxRetries: 0,
      streamingFirstByteTimeout: 5000,
      streamingIdleTimeout: 5000,
      nonStreamingTimeout: 5000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client" },
      body: JSON.stringify({
        model: "kimi-k2.7",
        input: [
          { type: "compaction", encrypted_content: "Prior summary" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(capturedBody).toBeDefined();
    const messages = capturedBody!.messages as Array<Record<string, unknown>>;
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("Prior summary");
    expect(messages[1].role).toBe("user");

    const json = await response.json();
    expect(json.output[0].content[0].text).toBe("Continuing from checkpoint");
  });

  it("returns models from the configured providers", async () => {
    const config: ProxyInstanceConfig = {
      profileName: "test",
      port: 0,
      listenAddress: "127.0.0.1",
      providers: [
        {
          id: "kimi",
          type: "kimi",
          name: "Kimi",
          baseUrl: "http://localhost:1",
          apiKey: "",
          models: ["kimi-k2", "kimi-k2-5"],
        },
        {
          id: "qianwen",
          type: "qianwen",
          name: "Qianwen",
          baseUrl: "http://localhost:2",
          apiKey: "",
          models: ["qwen-max"],
        },
      ],
      requestTimeout: 1000,
      maxRetries: 0,
      streamingFirstByteTimeout: 1000,
      streamingIdleTimeout: 1000,
      nonStreamingTimeout: 1000,
    };

    proxyServer = await startProxyServer(config.port, config.listenAddress, createRequestHandler(config));

    const response = await fetch(`${proxyServer.baseUrl}/v1/models`);
    expect(response.status).toBe(200);
    const json = await response.json();
    const ids = json.data.map((m: { id: string }) => m.id).sort();
    expect(ids).toEqual(["kimi-k2", "kimi-k2-5", "qwen-max"]);
  });
});
