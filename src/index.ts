import { Command } from "commander";
import { createRequire } from "module";
import { installGlobalExceptionHandlers, setLogLevel } from "./logger.js";
import { SETTINGS_FILE, ensureSettingsFile, readJson } from "./config.js";
import { profileCommand, useCommand, runCommand, unproxyCommand } from "./profiles/index.js";
import { hooksCommand } from "./hooks/index.js";
import { sessionCommand } from "./sessions/index.js";
import { completionCommand } from "./complete/index.js";
import { providerListCommand } from "./proxy/index.js";
import { cacheCommand } from "./cache/index.js";
import { codexVersionCommand } from "./codex-version/index.js";
import type { SettingsData } from "./types.js";

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

// Load log level from settings before any logging occurs
ensureSettingsFile();
const settings = readJson<SettingsData>(SETTINGS_FILE);
setLogLevel(settings._codex_hub_logLevel || "INFO");

installGlobalExceptionHandlers();

const program = new Command();

program
  .name("codex-hub")
  .description("Manage Codex CLI profiles, hooks, sessions, and providers")
  .version(version);

program.addCommand(profileCommand());
program.addCommand(useCommand());
program.addCommand(runCommand());
program.addCommand(unproxyCommand());
program.addCommand(hooksCommand());
program.addCommand(sessionCommand());
program.addCommand(completionCommand());
program.addCommand(providerListCommand());
program.addCommand(cacheCommand());
program.addCommand(codexVersionCommand());

try {
  program.parse();
} catch (err) {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
