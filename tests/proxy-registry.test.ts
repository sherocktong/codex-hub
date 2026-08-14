import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), `codx-proxy-registry-test-${process.pid}`);
process.env.CODX_PROXY_CONFIG_DIR = TEST_DIR;

import * as proxyRegistry from "../src/proxy/proxy-registry.js";

const TEST_REGISTRY_FILE = path.join(TEST_DIR, "proxy-registry.json");
const TEST_LOCK_FILE = path.join(TEST_DIR, "proxy-registry.lock");

proxyRegistry._setRegistryPaths(TEST_REGISTRY_FILE, TEST_LOCK_FILE);
proxyRegistry._setHealthChecker(async () => true);

describe("proxy-registry", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("detects current process as alive and missing PID as dead", () => {
    expect(proxyRegistry.isProcessAlive(process.pid)).toBe(true);
    expect(proxyRegistry.isProcessAlive(99999999)).toBe(false);
  });

  it("acquires and releases the lock", () => {
    proxyRegistry.acquireLock();
    expect(fs.existsSync(TEST_LOCK_FILE)).toBe(true);
    proxyRegistry.releaseLock();
    expect(fs.existsSync(TEST_LOCK_FILE)).toBe(false);
  });

  it("reclaims a stale lock from a dead process", () => {
    fs.writeFileSync(TEST_LOCK_FILE, "99999999", "utf-8");
    proxyRegistry.acquireLock();
    expect(fs.existsSync(TEST_LOCK_FILE)).toBe(true);
    proxyRegistry.releaseLock();
  });

  it("reads and writes registry entries", () => {
    proxyRegistry.writeRegistry({
      test: {
        profileName: "test",
        listenAddress: "127.0.0.1",
        port: 57001,
        proxyPid: process.pid,
        consumers: [process.pid],
        startedAt: Date.now(),
      },
    });
    const registry = proxyRegistry.readRegistry();
    expect(registry.test).toBeDefined();
    expect(registry.test.port).toBe(57001);
  });

  it("cleans dead owner entries", () => {
    proxyRegistry.writeRegistry({
      dead: {
        profileName: "dead",
        listenAddress: "127.0.0.1",
        port: 57002,
        proxyPid: 99999999,
        consumers: [99999999],
        startedAt: Date.now(),
      },
      alive: {
        profileName: "alive",
        listenAddress: "127.0.0.1",
        port: 57003,
        proxyPid: process.pid,
        consumers: [process.pid],
        startedAt: Date.now(),
      },
    });
    const cleaned = proxyRegistry.cleanDeadEntries(proxyRegistry.readRegistry());
    expect(cleaned.dead).toBeUndefined();
    expect(cleaned.alive).toBeDefined();
  });

  it("acquireProxy starts a server when no entry exists", async () => {
    let started = false;
    const acquisition = await proxyRegistry.acquireProxy(
      "p1",
      "127.0.0.1",
      async () => {
        started = true;
        return { baseUrl: "http://127.0.0.1:57010", port: 57010 };
      },
    );
    expect(started).toBe(true);
    expect(acquisition.isOwner).toBe(true);
    expect(acquisition.port).toBe(57010);

    const entry = proxyRegistry.getRegistryEntry("p1");
    expect(entry).toBeDefined();
    expect(entry!.consumers).toContain(process.pid);
  });

  it("acquireProxy reuses an existing healthy proxy", async () => {
    proxyRegistry.writeRegistry({
      p2: {
        profileName: "p2",
        listenAddress: "127.0.0.1",
        port: 57011,
        proxyPid: process.pid,
        consumers: [process.pid],
        startedAt: Date.now(),
      },
    });

    let started = false;
    const acquisition = await proxyRegistry.acquireProxy(
      "p2",
      "127.0.0.1",
      async () => {
        started = true;
        return { baseUrl: "http://127.0.0.1:57012", port: 57012 };
      },
    );
    expect(started).toBe(false);
    expect(acquisition.port).toBe(57011);

    const entry = proxyRegistry.getRegistryEntry("p2");
    expect(entry!.consumers).toHaveLength(1);
  });

  it("releaseProxy removes current process without stopping when other consumers exist", () => {
    let stopped = false;
    proxyRegistry.writeRegistry({
      p3: {
        profileName: "p3",
        listenAddress: "127.0.0.1",
        port: 57013,
        proxyPid: 99999997,
        consumers: [process.pid, 99999998],
        startedAt: Date.now(),
      },
    });

    const result = proxyRegistry.releaseProxy("p3", async () => {
      stopped = true;
    });
    expect(stopped).toBe(false);
    expect(result.remainingConsumers).toBe(0);
    expect(result.stopped).toBe(false);

    const entry = proxyRegistry.getRegistryEntry("p3");
    expect(entry).toBeUndefined();
  });

  it("releaseProxy stops and removes the entry when owner is last consumer", async () => {
    let stopped = false;
    proxyRegistry.writeRegistry({
      p4: {
        profileName: "p4",
        listenAddress: "127.0.0.1",
        port: 57014,
        proxyPid: process.pid,
        consumers: [process.pid],
        startedAt: Date.now(),
      },
    });

    const result = proxyRegistry.releaseProxy("p4", async () => {
      stopped = true;
    });
    expect(result.stopped).toBe(true);

    // Wait for async stop to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(true);
    expect(proxyRegistry.getRegistryEntry("p4")).toBeUndefined();
  });
});
