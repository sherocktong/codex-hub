import { Command } from "commander";
import {
  PROFILES_FILE,
  ensureProfilesFile,
  readJson,
  writeJson,
} from "../config.js";
import type { ProfilesData, Profile, ProviderType } from "../types.js";
import { getProviderConfig, getDefaultProviderPresets, readProxyConfig } from "../proxy/config.js";
import { stopAllProxies, getRunningProxy, reserveProxyPortAsync } from "../proxy/instance-manager.js";
import { execCodex } from "./runner.js";
import {
  syncNativeProfile,
  removeNativeProfile,
  isValidProfileName,
  deactivateProfileConfig,
} from "./profile-syncer.js";
import { safeAction } from "../logger.js";
import * as logger from "../logger.js";
import { ensureProviderPresetsExist } from "../proxy/instance-manager.js";

function resolveProfileProviderType(p: Profile): string {
  return p.provider || "(unset)";
}

function resolveProfileProxyUrl(profileName: string): string {
  const listenAddress = readProxyConfig().listenAddress;
  const running = getRunningProxy(profileName);
  const port = running?.server.port ?? 0;
  if (port > 0) {
    return `http://${listenAddress}:${port}`;
  }

  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  const persistedPort = data.profiles[profileName]?.proxyPort;
  if (persistedPort && persistedPort > 0) {
    return `http://${listenAddress}:${persistedPort}`;
  }
  return `http://${listenAddress}:<not running>`;
}

function maskToken(token: string): string {
  if (!token) return "(unset)";
  if (token.length <= 12) return token;
  return token.slice(0, 8) + "..." + token.slice(-4);
}

function formatModels(p: Profile): string {
  const models = p.models || (p.model ? [p.model] : []);
  if (models.length === 0) return "(unset)";
  const joined = models.join(", ");
  if (joined.length > 28) {
    return models[0] + ", +" + (models.length - 1) + " more";
  }
  return joined;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const VALID_PROVIDERS: ProviderType[] = ["kimi", "qianwen"];

function parseProvider(input: string | undefined): ProviderType | undefined {
  if (!input) return undefined;
  const lower = input.toLowerCase();
  if (VALID_PROVIDERS.includes(lower as ProviderType)) return lower as ProviderType;
  throw new Error(`Invalid provider '${input}'. Valid providers: ${VALID_PROVIDERS.join(", ")}`);
}

function validateProfileName(name: string): void {
  if (!isValidProfileName(name)) {
    throw new Error(
      `Profile name '${name}' contains invalid characters. Use only letters, numbers, hyphens, and underscores.`,
    );
  }
}

interface ProfileAddOptions {
  model?: string[];
  token?: string;
  url?: string;
  provider?: string;
}

interface ProfileUpdateOptions {
  model?: string[];
  deleteModel?: string[];
  token?: string;
  url?: string;
  provider?: string;
}

export async function addProfileAction(name: string, opts: ProfileAddOptions): Promise<void> {
  validateProfileName(name);

  const models = opts.model && opts.model.length > 0 ? opts.model : undefined;
  if (models && models.length > 3) {
    throw new Error("Error: A profile can have at most 3 models.");
  }

  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  if (data.profiles[name]) {
    throw new Error(`Profile '${name}' already exists. Use 'profile update' to modify it.`);
  }

  const profile: Profile = {};

  if (models) {
    profile.models = models;
    profile.model = models[0];
  }
  if (opts.token) profile.token = opts.token;
  if (opts.url) profile.url = opts.url;
  if (opts.provider) profile.provider = parseProvider(opts.provider);

  data.profiles[name] = profile;
  writeJson(PROFILES_FILE, data);
  logger.debug(`profile add: wrote ${PROFILES_FILE}`);

  // Reserve a proxy port for the profile without starting a long-running server.
  // profile add/update should not create a consumer that never unregisters.
  ensureProviderPresetsExist();
  let proxyUrl = resolveProfileProxyUrl(name);
  try {
    const reservedPort = await reserveProxyPortAsync(name);
    proxyUrl = `http://${readProxyConfig().listenAddress}:${reservedPort}`;
    await syncNativeProfile(name, profile, `${proxyUrl}/v1`);
  } catch (err) {
    logger.warn(`Could not reserve proxy port for profile '${name}'`, err);
  }

  console.log(`Profile '${name}' saved.`);
  console.log(`Provider:  ${resolveProfileProviderType(profile)}`);
  console.log(`Proxy URL: ${proxyUrl}`);
  console.log(`URL:       ${profile.url || "(default)"}`);
}

export async function updateProfileAction(name: string, opts: ProfileUpdateOptions): Promise<void> {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  if (!data.profiles[name]) {
    throw new Error(`Profile '${name}' not found. Use 'profile add' to create it.`);
  }
  const p = data.profiles[name];

  const providedModels = opts.model && opts.model.length > 0 ? opts.model : undefined;
  const modelsToDelete = opts.deleteModel && opts.deleteModel.length > 0 ? opts.deleteModel : undefined;

  if (modelsToDelete) {
    const toRemove = new Set(modelsToDelete);
    const currentModels = p.models || (p.model ? [p.model] : []);
    const newModels = currentModels.filter(m => !toRemove.has(m));
    const removedCount = currentModels.length - newModels.length;

    if (removedCount === 0) {
      console.log(`No matching models to remove from profile '${name}'.`);
    } else if (newModels.length === 0) {
      delete p.models;
      delete p.model;
      console.log(`Removed all models from profile '${name}'.`);
    } else {
      p.models = newModels;
      p.model = newModels[0];
      console.log(`Removed ${removedCount} model(s) from profile '${name}'.`);
    }
  }

  if (providedModels) {
    if (providedModels.length === 1) {
      const modelToSet = providedModels[0];
      const currentModels = p.models || (p.model ? [p.model] : []);
      const existingIndex = currentModels.indexOf(modelToSet);

      if (existingIndex !== -1) {
        currentModels.splice(existingIndex, 1);
        currentModels.unshift(modelToSet);
        p.models = currentModels;
        p.model = modelToSet;
        console.log(`Selected existing model '${modelToSet}' (position ${existingIndex + 1} -> 1).`);
      } else {
        currentModels.unshift(modelToSet);
        p.models = currentModels;
        p.model = modelToSet;
        console.log(`Added and selected new model '${modelToSet}'.`);
      }
    } else {
      p.models = providedModels;
      p.model = providedModels[0];
    }
  }

  const finalModels = p.models || (p.model ? [p.model] : []);
  if (finalModels.length > 3) {
    throw new Error("Error: A profile can have at most 3 models.");
  }

  if (opts.token) p.token = opts.token;
  if (opts.url) p.url = opts.url;
  if (opts.provider) p.provider = parseProvider(opts.provider);

  writeJson(PROFILES_FILE, data);
  logger.debug(`profile update: wrote ${PROFILES_FILE}`);

  // Reserve a proxy port for the profile without starting a long-running server.
  // profile add/update should not create a consumer that never unregisters.
  ensureProviderPresetsExist();
  let proxyUrl = resolveProfileProxyUrl(name);
  try {
    const reservedPort = await reserveProxyPortAsync(name);
    proxyUrl = `http://${readProxyConfig().listenAddress}:${reservedPort}`;
    await syncNativeProfile(name, p, `${proxyUrl}/v1`);
  } catch (err) {
    logger.warn(`Could not reserve proxy port for profile '${name}'`, err);
  }

  console.log(`Profile '${name}' updated.`);
  console.log(`Provider:  ${resolveProfileProviderType(p)}`);
  console.log(`Proxy URL: ${proxyUrl}`);
  console.log(`URL:       ${p.url || "(default)"}`);
}

export function listProfilesAction(): void {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  const profiles = data.profiles;
  const names = Object.keys(profiles);
  if (names.length === 0) {
    console.log("No profiles defined. Use 'profile add' to create one.");
    return;
  }
  const def = data.default || "";
  const fmt = (marker: string, name: string, model: string, token: string, provider: string, proxyUrl: string) =>
    `${marker.padEnd(2)}  ${name.padEnd(20)}  ${model.padEnd(30)}  ${token.padEnd(20)}  ${provider.padEnd(12)}  ${proxyUrl.padEnd(24)}`;

  console.log(fmt("", "NAME", "MODEL(S)", "TOKEN", "PROVIDER", "PROXY URL"));
  console.log(fmt("", "----", "--------", "-----", "--------", "---------"));
  for (const name of names) {
    const p = profiles[name];
    const marker = name === def ? "* " : "  ";
    console.log(fmt(
      marker,
      name,
      formatModels(p),
      maskToken(p.token || ""),
      p.provider || "openai",
      resolveProfileProxyUrl(name),
    ));
  }
}

export function viewProfileAction(name: string, opts: { json?: boolean }): void {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);

  const p = data.profiles[name];
  if (!p) {
    throw new Error(`Profile '${name}' not found.`);
  }
  if (opts.json) {
    console.log(JSON.stringify({ name, ...p }, null, 2));
  } else {
    console.log(`Name:     ${name}`);
    console.log(`Model:    ${p.model || "(unset)"}`);
    if (p.models && p.models.length > 0) {
      console.log(`Models:`);
      for (const m of p.models) {
        console.log(`  - ${m}`);
      }
    }
    console.log(`Token:    ${p.token || "(unset)"}`);
    console.log(`URL:      ${p.url || "(default)"}`);
    console.log(`Provider: ${p.provider || "openai"}`);
    console.log(`Proxy URL: ${resolveProfileProxyUrl(name)}`);
  }
}

export function removeProfileAction(name: string): void {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  if (!data.profiles[name]) {
    throw new Error(`Profile '${name}' not found.`);
  }
  delete data.profiles[name];
  writeJson(PROFILES_FILE, data);
  logger.debug(`profile remove: wrote ${PROFILES_FILE}`);

  // If config.toml is symlinked to the profile being removed, remove the symlink.
  deactivateProfileConfig(name);

  removeNativeProfile(name);
  console.log(`Profile '${name}' removed.`);
}

export function renameProfileAction(oldName: string, newName: string): void {
  validateProfileName(newName);

  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);
  if (!data.profiles[oldName]) {
    throw new Error(`Profile '${oldName}' not found.`);
  }
  if (data.profiles[newName]) {
    throw new Error(`Profile '${newName}' already exists. Choose a different name.`);
  }
  data.profiles[newName] = data.profiles[oldName];
  delete data.profiles[oldName];
  if (data.default === oldName) {
    data.default = newName;
  }
  writeJson(PROFILES_FILE, data);
  logger.debug(`profile rename: wrote ${PROFILES_FILE}`);

  removeNativeProfile(oldName);
  syncNativeProfile(newName, data.profiles[newName]).catch((err) => {
    logger.warn(`Could not sync native profile for '${newName}'`, err);
  });

  console.log(`Profile '${oldName}' renamed to '${newName}'.`);
}

export function useProfileAction(name: string): void {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);

  if (!data.profiles[name]) {
    throw new Error(`Profile '${name}' not found.`);
  }

  data.default = name;
  writeJson(PROFILES_FILE, data);
  logger.debug(`use: wrote ${PROFILES_FILE}`);
  console.log(`Default profile set to '${name}'.`);
}

export async function runProfileAction(args: string[]): Promise<void> {
  ensureProfilesFile();
  const data = readJson<ProfilesData>(PROFILES_FILE);

  let profileName = "";
  let codexArgs: string[];

  if (args.length > 0 && data.profiles[args[0]]) {
    profileName = args[0];
    codexArgs = args.slice(1);
  } else {
    profileName = data.default || "";
    codexArgs = args;
  }

  if (!profileName) {
    throw new Error("No default profile set. Use 'codx use <name>' first.");
  }

  const p = data.profiles[profileName];
  logger.debug(`run: launching codex with profile '${profileName}', args=[${codexArgs.join(", ")}]`);
  await execCodex(profileName, p, codexArgs);
}

export function profileCommand(): Command {
  const profile = new Command("profile")
    .description("Manage Codex CLI profiles");

  // --- add ---
  profile
    .command("add")
    .description("Add a new profile")
    .argument("<name>", "Profile name")
    .option("-m, --model <model>", "Model ID - can be used multiple times (max 3)", collect, [])
    .option("-t, --token <token>", "API key / token")
    .option("-u, --url <url>", "Base URL")
    .option("-p, --provider <provider>", `Provider type: ${VALID_PROVIDERS.join(" | ")}`)
    .action(safeAction(addProfileAction));

  // --- update ---
  profile
    .command("update")
    .description("Update fields of an existing profile")
    .argument("<name>", "Profile name (must already exist)")
    .option("-m, --model <model>", "Model ID - can be used multiple times", collect, [])
    .option("-d, --delete-model <model>", "Remove model ID - can be used multiple times", collect, [])
    .option("-t, --token <token>", "API key / token")
    .option("-u, --url <url>", "Base URL")
    .option("-p, --provider <provider>", `Provider type: ${VALID_PROVIDERS.join(" | ")}`)
    .action(safeAction(updateProfileAction));

  // --- list ---
  profile
    .command("list")
    .description("List all profiles")
    .action(safeAction(listProfilesAction));

  // --- view ---
  profile
    .command("view")
    .description("View full details of a profile (token unmasked)")
    .argument("<name>", "Profile name")
    .option("-j, --json", "Output as JSON")
    .action(safeAction(viewProfileAction));

  // --- remove ---
  profile
    .command("remove")
    .description("Remove a profile")
    .argument("<name>", "Profile name")
    .action(safeAction(removeProfileAction));

  // --- rename ---
  profile
    .command("rename")
    .description("Rename a profile")
    .argument("<oldName>", "Current profile name")
    .argument("<newName>", "New profile name")
    .action(safeAction(renameProfileAction));

  return profile;
}

export function unproxyCommand(): Command {
  return new Command("unproxy")
    .description("Stop all running provider proxies")
    .action(safeAction(async () => {
      await stopAllProxies();
      console.log("All provider proxies stopped.");
    }));
}

export function useCommand(): Command {
  return new Command("use")
    .description("Set a profile as the default")
    .argument("<name>", "Profile name")
    .action(safeAction(useProfileAction));
}

export function runCommand(): Command {
  return new Command("run")
    .description("Launch Codex CLI using the default or a specified profile")
    .allowUnknownOption()
    .argument("[args...]", "Optional profile name followed by extra arguments")
    .action(safeAction(runProfileAction));
}
