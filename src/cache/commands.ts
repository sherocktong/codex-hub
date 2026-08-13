import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { CODEX_DIR } from "../config.js";
import { safeAction } from "../logger.js";
import * as logger from "../logger.js";

const CODEX_CONFIG_FILE = path.join(CODEX_DIR, "config.json");

async function confirmPrompt(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(message);
  rl.close();
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

function findCodexProcesses(): number[] {
  const pids: number[] = [];
  const platform = process.platform;

  if (platform === "win32") {
    logger.debug("cache restore: scanning Windows processes via tasklist");
    const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
      encoding: "utf-8",
      shell: true,
    });
    if (result.status === 0 && result.stdout) {
      const lines = result.stdout.trim().split("\n");
      for (const line of lines) {
        const parts = line.split('","');
        if (parts.length >= 2) {
          const imageName = parts[0].replace(/^"/, "").trim();
          const pidStr = parts[1].replace(/"$/, "").trim();
          const lowerName = imageName.toLowerCase();
          if (lowerName === "codex.exe" || lowerName === "codex") {
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid) && pid !== process.pid) {
              pids.push(pid);
            }
          }
        }
      }
    }
  } else {
    logger.debug("cache restore: scanning Unix processes via ps");
    const result = spawnSync("ps", ["-eo", "pid,comm"], {
      encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout) {
      const lines = result.stdout.trim().split("\n");
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (match) {
          const pid = parseInt(match[1], 10);
          const comm = match[2].trim();
          if ((comm === "codex" || comm === "Codex") && pid !== process.pid) {
            pids.push(pid);
          }
        }
      }
    }
  }

  logger.debug(`cache restore: found ${pids.length} Codex process(es)`);
  return pids;
}

function killProcesses(pids: number[]): void {
  if (pids.length === 0) return;

  if (process.platform === "win32") {
    for (const pid of pids) {
      logger.debug(`cache restore: killing PID ${pid} via taskkill`);
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { shell: true });
    }
  } else {
    for (const pid of pids) {
      logger.debug(`cache restore: killing PID ${pid} via kill`);
      spawnSync("kill", ["-9", String(pid)]);
    }
  }
}

export function cacheCommand(): Command {
  const cache = new Command("cache")
    .description("Manage Codex CLI cache and backup files");

  cache
    .command("restore")
    .description(`Restore ${path.join(CODEX_DIR, "config.json.backup")} to ${CODEX_CONFIG_FILE}`)
    .action(safeAction(async () => {
      const backupPath = path.join(CODEX_DIR, "config.json.backup");
      const targetPath = CODEX_CONFIG_FILE;

      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup not found: ${backupPath}`);
      }

      const confirmed = await confirmPrompt(
        "This will terminate all running Codex CLI processes to prevent file conflicts. Continue? (y/N) "
      );
      if (!confirmed) {
        console.log("Restore cancelled.");
        return;
      }

      const pids = findCodexProcesses();
      if (pids.length > 0) {
        console.log(`Terminating ${pids.length} Codex CLI process(es)...`);
        killProcesses(pids);
      }

      fs.copyFileSync(backupPath, targetPath);
      logger.debug(`cache restore: restored ${backupPath} -> ${targetPath}`);
      console.log(`Restored ${backupPath} -> ${targetPath}`);
    }));

  return cache;
}
