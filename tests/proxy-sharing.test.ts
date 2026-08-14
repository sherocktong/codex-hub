import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), `codx-sharing-integration-${process.pid}`);
process.env.CODX_PROXY_CONFIG_DIR = TEST_DIR;

// Dynamic import is required so the registry module reads CODX_PROXY_CONFIG_DIR
// after it has been set. ESM hoists static imports above this assignment.
const proxyRegistry = await import("../src/proxy/proxy-registry.js");

const PROFILES_FILE = path.join(TEST_DIR, "profiles.json");
const MARKER_FILE = path.join(TEST_DIR, "consumers.txt");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "proxy-consumer.ts");

function spawnConsumer(name: string): Promise<{ child: ReturnType<typeof spawn>; pid: number; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", FIXTURE, "test", MARKER_FILE], {
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
    }, 15000);

    const interval = setInterval(() => {
      const match = output.match(/PID=(\d+) PORT=(\d+)/);
      if (match) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve({ child, pid: Number(match[1]), port: Number(match[2]) });
      }
    }, 100);
  });
}

describe("proxy sharing across processes", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
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
  });

  afterEach(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("shares a single proxy between two consumers and shuts down when the last leaves", async () => {
    const a = await spawnConsumer("A");
    const b = await spawnConsumer("B");

    expect(a.port).toBe(b.port);

    const registry = proxyRegistry.readRegistry();
    const entry = registry.test;
    expect(entry).toBeDefined();
    expect(entry.consumers).toContain(a.pid);
    expect(entry.consumers).toContain(b.pid);

    // Release B; proxy should still respond.
    b.child.stdin!.write("go\n");
    await new Promise((r) => setTimeout(r, 500));

    // Wait for B to actually release. Its process exits when stdin closes.
    b.child.stdin!.end();
    await new Promise((r) => setTimeout(r, 500));

    const registryAfterB = proxyRegistry.readRegistry();
    expect(registryAfterB.test).toBeDefined();
    expect(registryAfterB.test.consumers).toContain(a.pid);

    const health = await fetch(`http://127.0.0.1:${a.port}/health`, { signal: AbortSignal.timeout(1000) });
    expect(health.status).toBe(200);

    // Release A; proxy should stop.
    a.child.stdin!.write("go\n");
    a.child.stdin!.end();
    await new Promise((r) => setTimeout(r, 1000));

    expect(proxyRegistry.readRegistry().test).toBeUndefined();

    // Clean up just in case.
    try {
      a.child.kill("SIGKILL");
      b.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 30000);
});
