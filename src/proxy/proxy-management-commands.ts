import { Command } from "commander";
import { safeAction } from "../logger.js";
import {
  startManagedProfileProxy,
  stopManagedProfileProxy,
  stopAllManagedProxies,
  restartManagedProfileProxy,
  getManagedProxyStatus,
  listManagedProxyStatuses,
  type ManagedProxyStatus,
} from "./instance-manager.js";
import { readProxyLogLines } from "./logging.js";

function formatDuration(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function printStatus(status: ManagedProxyStatus): void {
  const health = status.healthy ? "healthy" : "unhealthy";
  console.log(`${status.profileName}:`);
  console.log(`  PID: ${status.pid}`);
  console.log(`  URL: ${status.baseUrl}`);
  console.log(`  Health: ${health}`);
  console.log(`  Uptime: ${formatDuration(status.startedAt)}`);
  console.log(`  Consumers: ${status.consumerCount}`);
}

export function proxyCommand(): Command {
  const command = new Command("proxy")
    .description("Manage provider proxy daemons");

  command
    .command("start <profileName>")
    .description("Start a proxy daemon for a profile")
    .action(safeAction(async (profileName: string) => {
      const { status, alreadyRunning } = await startManagedProfileProxy(profileName);
      if (alreadyRunning) {
        console.log(`Proxy daemon for '${profileName}' is already running on ${status.baseUrl} (PID ${status.pid}).`);
      } else {
        console.log(`Proxy daemon for '${profileName}' started on ${status.baseUrl} (PID ${status.pid}).`);
      }
    }));

  command
    .command("stop [profileName]")
    .description("Stop a proxy daemon, or all running proxies if no profile is given")
    .action(safeAction(async (profileName?: string) => {
      if (profileName) {
        const stopped = await stopManagedProfileProxy(profileName);
        if (stopped) {
          console.log(`Proxy daemon for '${profileName}' stopped.`);
        } else {
          console.log(`No running proxy daemon for '${profileName}'.`);
        }
      } else {
        await stopAllManagedProxies();
        console.log("All provider proxies stopped.");
      }
    }));

  command
    .command("restart <profileName>")
    .description("Restart a proxy daemon for a profile")
    .action(safeAction(async (profileName: string) => {
      const { status } = await restartManagedProfileProxy(profileName);
      console.log(`Proxy daemon for '${profileName}' restarted on ${status.baseUrl} (PID ${status.pid}).`);
    }));

  command
    .command("status [profileName]")
    .description("Show status of a proxy daemon, or all proxies if no profile is given")
    .action(safeAction(async (profileName?: string) => {
      if (profileName) {
        const status = await getManagedProxyStatus(profileName);
        if (!status) {
          console.log(`No running proxy daemon for '${profileName}'.`);
          return;
        }
        printStatus(status);
      } else {
        const statuses = await listManagedProxyStatuses();
        if (statuses.length === 0) {
          console.log("No running proxy daemons.");
          return;
        }
        for (const status of statuses) {
          printStatus(status);
        }
      }
    }));

  command
    .command("log <profileName>")
    .description("Show recent logs for a proxy daemon")
    .option("-l, --line <count>", "Number of lines to show", "100")
    .action(safeAction(async (profileName: string, options: { line: string }) => {
      const lineCount = parseInt(options.line, 10);
      if (!Number.isFinite(lineCount) || lineCount <= 0) {
        throw new Error(`Invalid line count: ${options.line}`);
      }
      const output = readProxyLogLines(profileName, lineCount);
      if (!output) {
        console.log(`No logs found for proxy '${profileName}'.`);
        return;
      }
      console.log(output);
    }));

  command
    .command("list")
    .description("List running proxy daemons")
    .action(safeAction(async () => {
      const statuses = await listManagedProxyStatuses();
      if (statuses.length === 0) {
        console.log("No running proxy daemons.");
        return;
      }
      console.log("Running proxy daemons:");
      for (const status of statuses) {
        const health = status.healthy ? "healthy" : "unhealthy";
        console.log(`  ${status.profileName}: ${status.baseUrl} (${health}, PID ${status.pid})`);
      }
    }));

  return command;
}
