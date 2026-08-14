import { Command } from "commander";
import net from "node:net";
import { PROFILES_FILE, ensureProfilesFile, readJson, writeJson } from "../config.js";
import type { ProfilesData } from "../types.js";
import { startProxyServer, findAvailablePort } from "./server.js";
import { createRequestHandler } from "./handlers.js";
import { buildProxyInstanceConfig, ensureProviderPresetsExist } from "./instance-manager.js";
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

        const config = buildProxyInstanceConfig(profileName, profile);
        ensureProviderPresetsExist();

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
      } catch (err) {
        logger.error(`Proxy daemon failed for profile`, err);
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
