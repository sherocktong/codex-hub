import { spawnSync } from "node:child_process";
import type { IBinaryResolver } from "./interfaces.js";
import { SETTINGS_FILE, ensureSettingsFile, readJson } from "../config.js";
import type { SettingsData } from "../types.js";
import * as logger from "../logger.js";

let cachedVersion: string | undefined;

export function getCodexVersion(): string {
  if (cachedVersion) return cachedVersion;

  logger.debug("binary-resolver: detecting Codex version");
  try {
    const result = spawnSync("codex", ["--version"], {
      shell: process.platform === "win32",
      encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout) {
      const match = result.stdout.trim().match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      if (match) {
        cachedVersion = match[1];
        logger.debug(`binary-resolver: detected Codex version ${cachedVersion}`);
        return cachedVersion;
      }
    }
  } catch {
    // fall through
  }

  cachedVersion = "0.0.0";
  logger.debug("binary-resolver: could not detect Codex version, using default");
  return cachedVersion;
}

function getPinnedVersion(): string | undefined {
  try {
    ensureSettingsFile();
    const settings = readJson<SettingsData>(SETTINGS_FILE);
    return typeof settings._codex_hub_pinnedCodexVersion === "string"
      ? settings._codex_hub_pinnedCodexVersion
      : undefined;
  } catch {
    return undefined;
  }
}

export class SystemBinaryResolver implements IBinaryResolver {
  resolve(pinnedVersion?: string): string {
    const pin = pinnedVersion ?? getPinnedVersion();

    logger.debug("binary-resolver: trying global 'codex' command");
    try {
      const result = spawnSync("codex", ["--version"], {
        shell: process.platform === "win32",
        encoding: "utf-8",
      });
      if (result.status === 0) {
        logger.debug("binary-resolver: found global 'codex'");
        if (pin) {
          const currentVersion = getCodexVersion();
          if (currentVersion !== pin) {
            logger.warn(`binary-resolver: global codex version ${currentVersion} does not match pinned version ${pin}`);
            console.warn(`Warning: installed Codex version (${currentVersion}) does not match pinned version (${pin}).`);
            console.warn(`To install the pinned version, run: npm install -g @openai/codex@${pin}`);
          } else {
            logger.debug(`binary-resolver: global codex version matches pinned ${pin}`);
          }
        }
        return "codex";
      }
    } catch {
      // fall through
    }

    throw new Error("Could not find Codex CLI. Install it globally: npm install -g @openai/codex");
  }
}
