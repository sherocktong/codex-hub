import { spawn, execSync } from "node:child_process";
import type { Profile } from "../types.js";
import { createBinaryResolver } from "../platform/index.js";
import { acquireProfileProxy } from "../proxy/instance-manager.js";
import { addRegistryConsumer, removeRegistryConsumer } from "../proxy/proxy-registry.js";
import {
  activateProfileConfig,
} from "./profile-syncer.js";
import * as logger from "../logger.js";

const DESKTOP_APP_START_TIMEOUT_MS = 10000;
const DESKTOP_APP_POLL_INTERVAL_MS = 1000;

export function isDesktopAppRunning(): boolean {
  if (process.platform === "win32") {
    try {
      execSync("powershell.exe -NoProfile -Command \"Get-Process Codex -ErrorAction SilentlyContinue\"", {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  // macOS: the desktop app is currently branded as ChatGPT.app with the Codex bundle.
  try {
    execSync("pgrep -x ChatGPT >/dev/null 2>&1 || pgrep -x Codex >/dev/null 2>&1");
    return true;
  } catch {
    return false;
  }
}

async function waitForDesktopAppToExit(): Promise<void> {
  // Kept for backwards compatibility; desktop launches now register the app
  // process as a proxy consumer instead of blocking the CLI.
  while (isDesktopAppRunning()) {
    await new Promise((resolve) => setTimeout(resolve, DESKTOP_APP_POLL_INTERVAL_MS));
  }
}

export function resolveCodexBinary(): string {
  return createBinaryResolver().resolve();
}

function getDesktopAppPid(): number | undefined {
  if (process.platform === "win32") {
    try {
      const output = execSync(
        "powershell.exe -NoProfile -Command \"Get-Process Codex -ErrorAction SilentlyContinue | Select-Object -First 1 Id\"",
        { encoding: "utf-8" },
      );
      const match = output.match(/(\d+)/);
      if (match) return Number(match[1]);
    } catch {
      // ignore
    }
    return undefined;
  }

  // macOS: try ChatGPT first, then Codex.
  for (const name of ["ChatGPT", "Codex"]) {
    try {
      const output = execSync(`pgrep -x ${name}`, { encoding: "utf-8" });
      const pid = Number(output.trim().split("\n")[0]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // ignore
    }
  }
  return undefined;
}

async function waitForDesktopAppStart(): Promise<number | undefined> {
  const deadline = Date.now() + DESKTOP_APP_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pid = getDesktopAppPid();
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

export function buildCodexCommand(args: {
  binary: string;
  profileName: string;
  extraArgs: string[];
  isDesktopApp: boolean;
}): string[] {
  if (args.isDesktopApp) {
    return [args.binary, ...args.extraArgs];
  }
  return [args.binary, "--profile", args.profileName, ...args.extraArgs];
}

export async function execCodex(profileName: string, p: Profile, extraArgs: string[]): Promise<void> {
  const models = p.models || (p.model ? [p.model] : []);
  const firstModel = models[0];
  const isDesktopApp = extraArgs[0] === "app";

  if (isDesktopApp) {
    throw new Error(
      "Launching the Codex Desktop app via codx is not supported. Please run `codex app` directly.",
    );
  }

  let acquired;
  try {
    acquired = await acquireProfileProxy(profileName);
  } catch (err) {
    logger.error(`Failed to acquire proxy for profile '${profileName}'`, err);
    throw err;
  }

  const binary = resolveCodexBinary();
  const proxyBaseUrl = `${acquired.running.server.baseUrl}/v1`;

  // Sync the per-profile file and merge it into the base config.toml.
  // Base config.toml is preserved: profile values overwrite duplicates and
  // base-only entries (user settings, project trust levels) are kept.
  activateProfileConfig(profileName, p, proxyBaseUrl);

  if (isDesktopApp) {
    logger.info(
      `Activated profile '${profileName}' for desktop: config.toml merged with ${profileName}.config.toml (proxy=${proxyBaseUrl} model=${firstModel || "(default)"})`,
    );
  } else {
    logger.info(
      `Synced profile '${profileName}': ${profileName}.config.toml (proxy=${proxyBaseUrl} model=${firstModel || "(default)"})`,
    );
  }

  const command = buildCodexCommand({ binary, profileName, extraArgs, isDesktopApp });

  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENAI_API_KEY: p.token || "codx",
    OPENAI_BASE_URL: proxyBaseUrl,
  };

  if (isDesktopApp) {
    console.error(`Launching Codex Desktop with profile '${profileName}'`);
  }

  logger.info(`Launching Codex with profile '${profileName}': model=${firstModel || "(default)"} proxy=${acquired.running.server.baseUrl} provider=${p.provider || "openai"} binary=${binary}`);
  logger.debug(`Codex command: ${command.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ")}`);

  const child = spawn(command[0], command.slice(1), {
    // CLI launches should inherit stdio so the user can type prompts and pipe
    // input. Desktop launches use "ignore" because the OS launcher detaches and
    // we want the codx CLI to exit immediately.
    stdio: isDesktopApp ? "ignore" : "inherit",
    env,
    shell: process.platform === "win32",
    detached: false,
  });

  return new Promise((resolve) => {
    child.on("exit", async (code) => {
      if (isDesktopApp) {
        // The desktop app is launched by the OS launcher, not as our child, so
        // the child exits immediately after opening the app. Register the actual
        // desktop process as a proxy consumer so the daemon stays alive, then
        // let the CLI exit.
        const desktopPid = await waitForDesktopAppStart();
        if (desktopPid) {
          addRegistryConsumer(profileName, desktopPid);
          logger.debug(`Registered desktop app PID ${desktopPid} as proxy consumer for '${profileName}'`);
        } else {
          logger.warn(`Could not detect desktop app PID; proxy may shut down when this CLI exits`);
        }
      }
      acquired.release();
      resolve();
      process.exit(code ?? 0);
    });
  });
}
