import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Profile } from "../types.js";
import { createBinaryResolver } from "../platform/index.js";
import { acquireProfileProxy } from "../proxy/instance-manager.js";
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

  let acquired;
  try {
    acquired = await acquireProfileProxy(profileName);
  } catch (err) {
    logger.error(`Failed to acquire proxy for profile '${profileName}'`, err);
    throw err;
  }

  const binary = resolveCodexBinary();
  const cmd = [binary];
  if (firstModel) cmd.push("--model", firstModel);

  // Codex CLI's config.toml provider base_url takes precedence over OPENAI_BASE_URL.
  // Override it so requests are routed through our local proxy.
  const providerName = detectCodexProviderName(readCodexConfig());
  const proxyBaseUrl = `${acquired.running.server.baseUrl}/v1`;
  // The Codex CLI requires each model_providers entry to have a non-empty `name`
  // field matching its table key; without it config loading fails with:
  // "model_providers.<name>: provider name must not be empty".
  cmd.push("-c", `model_providers.${providerName}.name="${providerName}"`);
  cmd.push("-c", `model_providers.${providerName}.base_url="${proxyBaseUrl}"`);
  // Without this override Codex CLI defaults to the built-in OpenAI provider and
  // sends requests to api.openai.com, causing a 401 when the profile token is a
  // third-party key (e.g. Kimi). Force the active provider to the one we just
  // configured so traffic is routed through our local proxy.
  cmd.push("-c", `model_provider="${providerName}"`);

  cmd.push(...extraArgs);

  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENAI_API_KEY: p.token || "codx",
    OPENAI_BASE_URL: proxyBaseUrl,
  };

  logger.info(`Launching Codex with profile '${profileName}': model=${firstModel || "(default)"} proxy=${acquired.running.server.baseUrl} provider=${p.provider || "openai"} binary=${binary}`);

  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

  return new Promise((resolve) => {
    child.on("exit", async (code) => {
      acquired.release();
      resolve();
      process.exit(code ?? 1);
    });
  });
}
