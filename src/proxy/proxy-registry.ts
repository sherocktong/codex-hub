import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as logger from "../logger.js";

export function getProxyConfigDir(): string {
  return process.env.CODX_PROXY_CONFIG_DIR || path.join(os.homedir(), ".codex", "codx");
}

let REGISTRY_FILE = path.join(getProxyConfigDir(), "proxy-registry.json");
let LOCK_FILE = path.join(getProxyConfigDir(), "proxy-registry.lock");

export function _setRegistryPaths(registryFile: string, lockFile: string): void {
  REGISTRY_FILE = registryFile;
  LOCK_FILE = lockFile;
}

export { REGISTRY_FILE as _REGISTRY_FILE, LOCK_FILE as _LOCK_FILE };

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

export interface ProxyRegistryEntry {
  profileName: string;
  listenAddress: string;
  port: number;
  proxyPid: number;
  consumers: number[];
  startedAt: number;
}

export interface ProxyRegistry {
  [profileName: string]: ProxyRegistryEntry;
}

function ensureConfigDir(): void {
  const dir = path.dirname(REGISTRY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(): number | undefined {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf-8").trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0) return pid;
  } catch {
    // ignore
  }
  return undefined;
}

function tryAcquireLock(): boolean {
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      const holder = readLockPid();
      if (holder && !isProcessAlive(holder)) {
        try {
          fs.unlinkSync(LOCK_FILE);
          return tryAcquireLock();
        } catch {
          return false;
        }
      }
    }
    return false;
  }
}

export function acquireLock(): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (tryAcquireLock()) return;
    // Synchronous but bounded wait; acceptable because registry ops are fast.
    const remaining = deadline - Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(LOCK_RETRY_MS, remaining));
  }
  throw new Error("Timeout acquiring proxy registry lock");
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.error("Failed to release proxy registry lock", err);
    }
  }
}

export function readRegistry(): ProxyRegistry {
  ensureConfigDir();
  if (!fs.existsSync(REGISTRY_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8")) as ProxyRegistry;
  } catch (err) {
    logger.error("Failed to read proxy registry", err);
    return {};
  }
}

export function writeRegistry(registry: ProxyRegistry): void {
  ensureConfigDir();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

export function cleanDeadEntries(registry: ProxyRegistry): ProxyRegistry {
  const cleaned: ProxyRegistry = {};
  for (const [profileName, entry] of Object.entries(registry)) {
    if (!isProcessAlive(entry.proxyPid)) {
      logger.debug(`cleanDeadEntries: owner ${entry.proxyPid} for '${profileName}' is dead`);
      continue;
    }
    const liveConsumers = entry.consumers.filter(isProcessAlive);
    if (liveConsumers.length === 0) {
      logger.debug(`cleanDeadEntries: no live consumers for '${profileName}'`);
      continue;
    }
    cleaned[profileName] = { ...entry, consumers: liveConsumers };
  }
  return cleaned;
}

export async function checkProxyHealth(baseUrl: string): Promise<boolean> {
  if (customHealthChecker) return customHealthChecker(baseUrl);
  return defaultCheckProxyHealth(baseUrl);
}

let customHealthChecker: ((baseUrl: string) => Promise<boolean>) | undefined;

export function _setHealthChecker(checker: (baseUrl: string) => Promise<boolean>): void {
  customHealthChecker = checker;
}

async function defaultCheckProxyHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export interface ProxyAcquisition {
  baseUrl: string;
  port: number;
  ownerPid: number;
  /** True if the proxy server was started by the current process. */
  isOwner: boolean;
}

export async function acquireProxy(
  profileName: string,
  listenAddress: string,
  startServer: () => Promise<{ baseUrl: string; port: number }>,
): Promise<ProxyAcquisition> {
  acquireLock();
  try {
    let registry = readRegistry();
    registry = cleanDeadEntries(registry);

    const existing = registry[profileName];
    if (existing) {
      const baseUrl = `http://${existing.listenAddress}:${existing.port}`;
      if (await checkProxyHealth(baseUrl)) {
        if (!existing.consumers.includes(process.pid)) {
          existing.consumers.push(process.pid);
        }
        registry[profileName] = existing;
        writeRegistry(registry);
        return {
          baseUrl,
          port: existing.port,
          ownerPid: existing.proxyPid,
          isOwner: existing.proxyPid === process.pid,
        };
      }
      logger.debug(`acquireProxy: existing proxy for '${profileName}' at ${baseUrl} is unhealthy`);
      delete registry[profileName];
    }

    const server = await startServer();
    const entry: ProxyRegistryEntry = {
      profileName,
      listenAddress,
      port: server.port,
      proxyPid: process.pid,
      consumers: [process.pid],
      startedAt: Date.now(),
    };
    registry[profileName] = entry;
    writeRegistry(registry);

    return {
      baseUrl: server.baseUrl,
      port: server.port,
      ownerPid: process.pid,
      isOwner: true,
    };
  } finally {
    releaseLock();
  }
}

export function releaseProxy(
  profileName: string,
  stopServer: () => Promise<void>,
): { remainingConsumers: number; stopped: boolean } {
  acquireLock();
  try {
    let registry = readRegistry();
    registry = cleanDeadEntries(registry);

    const entry = registry[profileName];
    if (!entry) {
      return { remainingConsumers: 0, stopped: false };
    }

    entry.consumers = entry.consumers.filter((pid) => pid !== process.pid);

    const remainingConsumers = entry.consumers.length;
    const isOwner = entry.proxyPid === process.pid;

    if (remainingConsumers === 0 && isOwner) {
      delete registry[profileName];
      writeRegistry(registry);
      // Stop the server after releasing the lock to keep the critical section short.
      stopServer().catch((err) => logger.error("Error stopping proxy server", err));
      return { remainingConsumers: 0, stopped: true };
    }

    registry[profileName] = entry;
    writeRegistry(registry);
    return { remainingConsumers, stopped: false };
  } finally {
    releaseLock();
  }
}

export function getRegistryEntry(profileName: string): ProxyRegistryEntry | undefined {
  const registry = cleanDeadEntries(readRegistry());
  return registry[profileName];
}

export function listRegistryEntries(): ProxyRegistryEntry[] {
  const registry = cleanDeadEntries(readRegistry());
  return Object.values(registry);
}

export function stopAllOwnedProxies(stopServer: (entry: ProxyRegistryEntry) => Promise<void>): void {
  acquireLock();
  try {
    let registry = readRegistry();
    registry = cleanDeadEntries(registry);

    for (const [profileName, entry] of Object.entries(registry)) {
      if (entry.proxyPid === process.pid) {
        delete registry[profileName];
        writeRegistry(registry);
        stopServer(entry).catch((err) => logger.error("Error stopping owned proxy", err));
      }
    }
  } finally {
    releaseLock();
  }
}

export function removeDeadProxy(profileName: string): boolean {
  acquireLock();
  try {
    const registry = readRegistry();
    const entry = registry[profileName];
    if (entry && (!isProcessAlive(entry.proxyPid) || entry.consumers.filter(isProcessAlive).length === 0)) {
      delete registry[profileName];
      writeRegistry(registry);
      return true;
    }
    return false;
  } finally {
    releaseLock();
  }
}
