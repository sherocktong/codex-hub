import { SETTINGS_FILE, ensureSettingsFile, readJson, writeJson } from "../config.js";
import type { SettingsData } from "../types.js";

export function getPinnedVersion(): string | undefined {
  ensureSettingsFile();
  const settings = readJson<SettingsData>(SETTINGS_FILE);
  return typeof settings._codex_hub_pinnedCodexVersion === "string"
    ? settings._codex_hub_pinnedCodexVersion
    : undefined;
}

export function setPinnedVersion(version: string | undefined): void {
  ensureSettingsFile();
  const settings = readJson<SettingsData>(SETTINGS_FILE);
  if (version) {
    settings._codex_hub_pinnedCodexVersion = version;
  } else {
    delete settings._codex_hub_pinnedCodexVersion;
  }
  writeJson(SETTINGS_FILE, settings);
}
