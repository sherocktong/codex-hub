import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), `codx-proxy-management-${process.pid}`);
process.env.CODEX_DIR = TEST_DIR;
process.env.CODX_PROXY_CONFIG_DIR = path.join(TEST_DIR, "proxy");

// Dynamic import is required so the registry module reads CODX_PROXY_CONFIG_DIR
// after it has been set. ESM hoists static imports above this assignment.
const instanceManager = await import("../src/proxy/instance-manager.js");
const logging = await import("../src/proxy/logging.js");

const PROFILES_FILE = path.join(TEST_DIR, "profiles.json");
const DAEMON_STARTUP_TIMEOUT_MS = 15000;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 6000;
const POLL_INTERVAL_MS = 100;

function createProfiles(): void {
  fs.mkdirSync(path.join(TEST_DIR, "proxy"), { recursive: true });
  fs.writeFileSync(
    PROFILES_FILE,
    JSON.stringify(
      {
        profiles: {
          kimi: {
            provider: "kimi",
            model: "kimi-k2-5-coding",
            token: "fake-token",
          },
          qianwen: {
            provider: "qianwen",
            model: "qwen-max",
            token: "fake-token",
          },
        },
        default: "kimi",
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

async function waitForHealth(baseUrl: string, timeoutMs = DAEMON_STARTUP_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
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

describe("proxy management commands", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createProfiles();
  });

  afterEach(async () => {
    try {
      await instanceManager.stopAllManagedProxies();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("starts and stops a managed proxy for a profile", async () => {
    const { status, alreadyRunning } = await instanceManager.startManagedProfileProxy("kimi");
    expect(alreadyRunning).toBe(false);
    expect(status.profileName).toBe("kimi");
    expect(status.healthy).toBe(true);
    expect(status.port).toBeGreaterThan(0);

    const healthy = await waitForHealth(status.baseUrl);
    expect(healthy).toBe(true);

    const restarted = await instanceManager.startManagedProfileProxy("kimi");
    expect(restarted.alreadyRunning).toBe(true);

    const stopped = await instanceManager.stopManagedProfileProxy("kimi");
    expect(stopped).toBe(true);

    const stopped2 = await instanceManager.stopManagedProfileProxy("kimi");
    expect(stopped2).toBe(false);

    const finalStatus = await instanceManager.getManagedProxyStatus("kimi");
    expect(finalStatus).toBeUndefined();
  }, 30000);

  it("keeps a managed proxy running without external consumers", async () => {
    const { status } = await instanceManager.startManagedProfileProxy("kimi");

    // The daemon should stay alive for at least a few seconds because it is
    // registered as its own consumer.
    await new Promise((r) => setTimeout(r, 1500));

    const stillHealthy = await waitForHealth(status.baseUrl, 2000);
    expect(stillHealthy).toBe(true);
  }, 30000);

  it("runs multiple provider proxies concurrently on distinct ports", async () => {
    const { status: kimi } = await instanceManager.startManagedProfileProxy("kimi");
    const { status: qianwen } = await instanceManager.startManagedProfileProxy("qianwen");

    expect(kimi.port).not.toBe(qianwen.port);

    const kimiHealthy = await waitForHealth(kimi.baseUrl);
    const qianwenHealthy = await waitForHealth(qianwen.baseUrl);
    expect(kimiHealthy).toBe(true);
    expect(qianwenHealthy).toBe(true);

    const statuses = await instanceManager.listManagedProxyStatuses();
    expect(statuses).toHaveLength(2);
    const names = statuses.map((s) => s.profileName).sort();
    expect(names).toEqual(["kimi", "qianwen"]);
  }, 30000);

  it("restarts a managed proxy", async () => {
    const { status: before } = await instanceManager.startManagedProfileProxy("kimi");
    const healthy = await waitForHealth(before.baseUrl);
    expect(healthy).toBe(true);

    const { status: after } = await instanceManager.restartManagedProfileProxy("kimi");
    expect(after.profileName).toBe("kimi");
    expect(after.port).toBe(before.port);

    const stillHealthy = await waitForHealth(after.baseUrl);
    expect(stillHealthy).toBe(true);

    // The original PID should no longer be running.
    let pidGone = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(before.pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        pidGone = true;
        break;
      }
    }
    expect(pidGone).toBe(true);
  }, 30000);

  it("reads recent proxy log lines from the per-profile log folder", async () => {
    await instanceManager.startManagedProfileProxy("kimi");

    // Wait for the log file to be created and written.
    const logDir = logging.getProxyLogDir("kimi");
    const deadline = Date.now() + 5000;
    let logFile: string | undefined;
    while (Date.now() < deadline) {
      const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".log"));
      if (files.length > 0) {
        logFile = path.join(logDir, files[0]);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(logFile).toBeDefined();

    fs.appendFileSync(logFile!, "line1\nline2\nline3\nline4\nline5\n", "utf-8");

    const allOutput = logging.readProxyLogLines("kimi", 100);
    expect(allOutput).toContain("line1");
    expect(allOutput).toContain("line5");

    const tailOutput = logging.readProxyLogLines("kimi", 2);
    expect(tailOutput).toContain("line5");
  }, 30000);
});
