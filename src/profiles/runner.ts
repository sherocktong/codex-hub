import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Profile } from "../types.js";
import { createBinaryResolver } from "../platform/index.js";
import { startProfileProxy, stopAllProxies } from "../proxy/instance-manager.js";
import * as logger from "../logger.js";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_CONFIG_FILE = path.join(CODEX_HOME, "config.toml");

export function resolveCodexBinary(): string {
  return createBinaryResolver().resolve();
}

function readCodexConfig(): string {
  try {
    return fs.readFileSync(CODEX_CONFIG_FILE, "utf-8");
  } catch {
    return "";
  }
}

function detectCodexProviderName(configText: string): string {
  const match = configText.match(/^model_provider\s*=\s*["']([^"']+)["']/m);
  return match?.[1] || "custom";
}

export async function execCodex(profileName: string, p: Profile, extraArgs: string[]): Promise<void> {
  const models = p.models || (p.model ? [p.model] : []);
  const firstModel = models[0];

  // Ensure the profile's provider proxy is running on an auto-allocated port.
  let proxy;
  try {
    proxy = await startProfileProxy(profileName);
  } catch (err) {
    logger.error(`Failed to start proxy for profile '${profileName}'`, err);
    throw err;
  }

  const binary = resolveCodexBinary();
  const cmd = [binary];
  if (firstModel) cmd.push("--model", firstModel);

  // Codex CLI's config.toml provider base_url takes precedence over OPENAI_BASE_URL.
  // Override it so requests are routed through our local proxy.
  const providerName = detectCodexProviderName(readCodexConfig());
  const proxyBaseUrl = `${proxy.server.baseUrl}/v1`;
  cmd.push("-c", `model_providers.${providerName}.base_url="${proxyBaseUrl}"`);

  cmd.push(...extraArgs);

  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENAI_API_KEY: p.token || "codex-hub",
    OPENAI_BASE_URL: proxyBaseUrl,
  };

  logger.info(`Launching Codex with profile '${profileName}': model=${firstModel || "(default)"} proxy=${proxy.server.baseUrl} provider=${p.provider || "openai"} binary=${binary}`);

  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

  return new Promise((resolve) => {
    child.on("exit", async (code) => {
      await stopAllProxies();
      resolve();
      process.exit(code ?? 1);
    });
  });
}
