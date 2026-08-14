import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), `codx-daemon-lifecycle-${process.pid}`);
process.env.CODEX_DIR = TEST_DIR;
process.env.CODX_PROXY_CONFIG_DIR = path.join(TEST_DIR, "proxy");

// Dynamic import is required so the registry module reads CODX_PROXY_CONFIG_DIR
// after it has been set. ESM hoists static imports above this assignment.
const proxyRegistry = await import("../src/proxy/proxy-registry.js");

const PROFILES_FILE = path.join(TEST_DIR, "profiles.json");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "proxy-consumer.ts");
const DAEMON_STARTUP_TIMEOUT_MS = 15000;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 6000;
const POLL_INTERVAL_MS = 100;

function createProfile(): void {
  fs.mkdirSync(path.join(TEST_DIR, "proxy"), { recursive: true });
  fs.writeFileSync(
    PROFILES_FILE,
    JSON.stringify(
      {
        profiles: {
          test: {
            provider: "kimi",
            model: "kimi-k2-5-coding",
            token: "fake-token",
          },
        },
        default: "test",
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "proxy", "providers.json"),
    JSON.stringify(
      {
        kimi: {
          id: "kimi",
          type: "kimi",
          name: "Kimi",
          baseUrl: "https://api.kimi.com/coding",
          apiKey: "",
          models: ["kimi-k2-5-coding"],
          promptCacheRouting: "enabled",
          responsesToChatCompletions: true,
        },
        qianwen: {
          id: "qianwen",
          type: "qianwen",
          name: "Qianwen",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "",
          models: ["qwen-max"],
          promptCacheRouting: "enabled",
          responsesToChatCompletions: true,
        },
      },
      null,
      2,
    ),
  );
}

function killProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
}

function spawnConsumer(name: string): Promise<{ child: ReturnType<typeof spawn>; pid: number; port: number }> {
  return new Promise((resolve, reject) => {
    const markerFile = path.join(TEST_DIR, `consumer-${name}-${process.pid}.txt`);
    const child = spawn("npx", ["tsx", FIXTURE, "test", markerFile], {
      env: {
        ...process.env,
        CODEX_DIR: TEST_DIR,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      console.error(`[${name}]`, data.toString().trim());
    });
    child.on("error", reject);

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timeout waiting for ${name} to acquire proxy`));
    }, DAEMON_STARTUP_TIMEOUT_MS);

    const interval = setInterval(() => {
      const match = output.match(/PID=(\d+) PORT=(\d+)/);
      if (match) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve({ child, pid: Number(match[1]), port: Number(match[2]) });
      }
    }, POLL_INTERVAL_MS);
  });
}

async function waitForProxyStop(port: number, timeoutMs = DAEMON_SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function waitForConsumerRemoval(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const registry = proxyRegistry.readRegistry();
    if (!registry.test?.consumers.includes(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

describe("proxy daemon lifecycle", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createProfile();
  });

  afterEach(async () => {
    // Kill any leftover consumer fixture processes and orphaned daemons before
    // wiping the test directory.
    try {
      if (fs.existsSync(TEST_DIR)) {
        for (const file of fs.readdirSync(TEST_DIR)) {
          if (file.startsWith("consumer-") && file.endsWith(".txt")) {
            const content = fs.readFileSync(path.join(TEST_DIR, file), "utf-8").trim();
            for (const pidStr of content.split("\n")) {
              const pid = Number(pidStr.trim());
              if (Number.isFinite(pid) && pid > 0) {
                killProcess(pid);
              }
            }
          }
        }
      }
      const registry = proxyRegistry.readRegistry();
      if (registry.test) {
        killProcess(registry.test.proxyPid);
      }
    } catch {
      // ignore
    }

    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("stops the proxy daemon when its only consumer process is killed", async () => {
    const consumer = await spawnConsumer("A");

    const registry = proxyRegistry.readRegistry();
    const entry = registry.test;
    expect(entry).toBeDefined();
    expect(entry.consumers).toContain(consumer.pid);

    // Kill the consumer abruptly (simulates terminal tab close).
    killProcess(consumer.pid);

    const stopped = await waitForProxyStop(consumer.port);
    expect(stopped).toBe(true);
    expect(proxyRegistry.readRegistry().test).toBeUndefined();
  }, 30000);

  it("keeps the proxy daemon running when another consumer is still alive", async () => {
    const a = await spawnConsumer("A");
    const b = await spawnConsumer("B");

    expect(a.port).toBe(b.port);

    const registry = proxyRegistry.readRegistry();
    expect(registry.test).toBeDefined();
    expect(registry.test.consumers).toContain(a.pid);
    expect(registry.test.consumers).toContain(b.pid);

    // Kill A; B should keep the proxy alive.
    killProcess(a.pid);

    const stillHealthy = await fetch(`http://127.0.0.1:${a.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    expect(stillHealthy.status).toBe(200);

    const aRemoved = await waitForConsumerRemoval(a.pid);
    expect(aRemoved).toBe(true);

    const registryAfterA = proxyRegistry.readRegistry();
    expect(registryAfterA.test).toBeDefined();
    expect(registryAfterA.test.consumers).not.toContain(a.pid);
    expect(registryAfterA.test.consumers).toContain(b.pid);

    // Clean up B.
    b.child.stdin!.write("go\n");
    b.child.stdin!.end();
    await new Promise((r) => setTimeout(r, 1000));

    try {
      a.child.kill("SIGKILL");
      b.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 30000);
});
