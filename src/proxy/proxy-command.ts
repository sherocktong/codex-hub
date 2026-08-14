import { Command } from "commander";
import net from "node:net";
import { PROFILES_FILE, ensureProfilesFile, readJson, writeJson } from "../config.js";
import type { ProfilesData } from "../types.js";
import { startProxyServer, findAvailablePort } from "./server.js";
import { createRequestHandler } from "./handlers.js";
import { buildProxyInstanceConfig, ensureProviderPresetsExist } from "./instance-manager.js";
import {
  acquireLock,
  tryAcquireLock,
  releaseLock,
  readRegistry,
  writeRegistry,
  isProcessAlive,
  cleanDeadEntries,
  type ProxyRegistry,
} from "./proxy-registry.js";
import * as logger from "../logger.js";

export function proxyServerCommand(): Command {
  return new Command("__proxy-server")
    .description("Internal command: start a profile proxy daemon")
    .argument("<profileName>", "Profile name")
    .action(async (profileName: string) => {
      try {
        ensureProfilesFile();
        const data = readJson<ProfilesData>(PROFILES_FILE);
        const profile = data.profiles[profileName];
        if (!profile) {
          console.error(`Profile '${profileName}' not found.`);
          process.exit(1);
        }

        ensureProviderPresetsExist();
        const config = buildProxyInstanceConfig(profileName, profile);

        const requestHandler = createRequestHandler(config);

        // If a persisted port is in use (e.g. stale daemon or another process), fall back to a
        // fresh available port instead of crashing with EADDRINUSE.
        let startPort = config.port;
        if (startPort !== 0) {
          const available = await new Promise<boolean>((resolve) => {
            const tester = net
              .createServer()
              .once("error", () => resolve(false))
              .once("listening", () => {
                tester.close(() => resolve(true));
              })
              .listen(startPort, config.listenAddress);
          });
          if (!available) {
            logger.warn(`Configured proxy port ${startPort} is in use; picking a new port`);
            startPort = await findAvailablePort(config.listenAddress);
          }
        }

        const server = await startProxyServer(startPort, config.listenAddress, requestHandler);

        // Persist the actual bound port so consumers can reconnect after owner restarts.
        if (profile.proxyPort !== server.port) {
          const fresh = readJson<ProfilesData>(PROFILES_FILE);
          fresh.profiles[profileName] = { ...profile, proxyPort: server.port };
          writeJson(PROFILES_FILE, fresh);
          logger.debug(`proxy daemon persisted port: ${profileName} -> ${server.port}`);
        }

        console.log(`PROXY_READY port=${server.port}`);
        logger.info(`Proxy daemon for '${profileName}' listening on ${server.baseUrl}`);

        const parentPid = Number(process.env.CODX_PROXY_PARENT_PID);
        startParentLivenessWatcher(profileName, parentPid, server);
        startConsumerLivenessWatcher(profileName, server);

        process.on("SIGTERM", async () => {
          logger.debug(`Proxy daemon for '${profileName}' received SIGTERM`);
          await server.stop();
          process.exit(0);
        });

        process.on("SIGINT", async () => {
          logger.debug(`Proxy daemon for '${profileName}' received SIGINT`);
          await server.stop();
          process.exit(0);
        });

        process.on("SIGHUP", async () => {
          logger.debug(`Proxy daemon for '${profileName}' received SIGHUP`);
          try {
            await shutdownIfUnused(profileName, server);
          } catch (err) {
            logger.error(`Shutdown check failed for '${profileName}'`, err);
          }
          process.exit(0);
        });
      } catch (err) {
        logger.error(`Proxy daemon failed for profile`, err);
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function startParentLivenessWatcher(profileName: string, parentPid: number, server: Awaited<ReturnType<typeof startProxyServer>>): void {
  if (!Number.isFinite(parentPid) || parentPid <= 0) {
    logger.debug(`No valid CODX_PROXY_PARENT_PID for '${profileName}', skipping liveness watcher`);
    return;
  }

  const checkIntervalMs = 1000;
  const interval = setInterval(() => {
    if (isProcessAlive(parentPid)) return;

    clearInterval(interval);
    logger.debug(`Parent process ${parentPid} for '${profileName}' is gone; consumer watcher will handle shutdown`);
    // Do not shut down here. Another consumer may be registering concurrently,
    // and reading the registry from this watcher can race with that update.
    // The consumer liveness watcher will stop the daemon when no consumers remain.
  }, checkIntervalMs);

  interval.unref();
}

function startConsumerLivenessWatcher(profileName: string, server: Awaited<ReturnType<typeof startProxyServer>>): void {
  const checkIntervalMs = 1000;
  const interval = setInterval(async () => {
    // Never block the daemon's event loop waiting for the registry lock. A
    // consumer may be holding the lock while it health-checks this daemon; if
    // we block, the health check times out and the consumer spawns a new proxy.
    if (!tryAcquireLock()) return;

    try {
      let registry = readRegistry();
      registry = cleanDeadEntries(registry);
      const entry = registry[profileName];
      if (!entry) {
        clearInterval(interval);
        // Persist the cleaned registry so stale entries are removed even when
        // the daemon is shutting down because its only consumer died.
        writeRegistry(registry);
        logger.debug(`No registry entry for '${profileName}', stopping proxy daemon`);
        await server.stop();
        process.exit(0);
      }

      const liveConsumers = entry.consumers.filter(isProcessAlive);
      if (liveConsumers.length === 0) {
        clearInterval(interval);
        delete registry[profileName];
        writeRegistry(registry);
        logger.debug(`No live consumers for '${profileName}', stopping proxy daemon`);
        await server.stop();
        process.exit(0);
      }

      entry.consumers = liveConsumers;
      registry[profileName] = entry;
      writeRegistry(registry);
    } catch (err) {
      logger.error(`Consumer liveness check failed for '${profileName}'`, err);
    } finally {
      releaseLock();
    }
  }, checkIntervalMs);

  interval.unref();
}

async function shutdownIfUnusedWithRetry(
  profileName: string,
  server: Awaited<ReturnType<typeof startProxyServer>>,
): Promise<void> {
  // Try to acquire the registry lock without blocking. If another process is
  // updating the registry, retry briefly and then give up rather than stalling
  // the daemon's HTTP handler.
  const deadline = Date.now() + 3000;
  while (!tryAcquireLock()) {
    if (Date.now() >= deadline) {
      throw new Error("Timeout acquiring registry lock for shutdown check");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  try {
    const registry = readRegistry();
    const entry = registry[profileName];
    if (!entry) {
      logger.debug(`No registry entry for '${profileName}', stopping proxy daemon`);
      await server.stop();
      process.exit(0);
    }

    const liveConsumers = entry.consumers.filter(isProcessAlive);
    if (liveConsumers.length === 0) {
      delete registry[profileName];
      writeRegistry(registry);
      logger.debug(`No live consumers for '${profileName}', stopping proxy daemon`);
      await server.stop();
      process.exit(0);
    }

    entry.consumers = liveConsumers;
    registry[profileName] = entry;
    writeRegistry(registry);
    logger.debug(`Proxy daemon for '${profileName}' has other consumers, staying alive`);
  } finally {
    releaseLock();
  }
}

async function shutdownIfUnused(
  profileName: string,
  server: Awaited<ReturnType<typeof startProxyServer>>,
): Promise<void> {
  await shutdownIfUnusedWithRetry(profileName, server);
}
