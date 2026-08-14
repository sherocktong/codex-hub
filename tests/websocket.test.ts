import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
});
