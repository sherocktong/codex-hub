import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), `codx-profiles-commands-test-${process.pid}`);
process.env.CODEX_DIR = TEST_DIR;
process.env.CODEX_HOME = TEST_DIR;
process.env.CODEX_PROFILES_FILE = path.join(TEST_DIR, "profiles.json");
process.env.CODX_PROXY_CONFIG_DIR = TEST_DIR;

import * as instanceManager from "../src/proxy/instance-manager.js";
import * as profileSyncer from "../src/profiles/profile-syncer.js";
import {
  addProfileAction,
  updateProfileAction,
  removeProfileAction,
  renameProfileAction,
  useProfileAction,
} from "../src/profiles/commands.js";
import { PROFILES_FILE, ensureProfilesFile, readJson } from "../src/config.js";
import type { ProfilesData } from "../src/types.js";

describe("profiles commands", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    vi.spyOn(instanceManager, "reserveProxyPortAsync").mockResolvedValue(57001);
    vi.spyOn(instanceManager, "ensureProviderPresetsExist").mockImplementation(() => {});
    vi.spyOn(profileSyncer, "syncNativeProfile").mockResolvedValue(undefined);
    vi.spyOn(profileSyncer, "removeNativeProfile").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("addProfileAction writes profiles.json, reserves port, and syncs native profile", async () => {
    await addProfileAction("kimi-dev", {
      model: ["kimi-k2-5-coding"],
      token: "sk-test",
      provider: "kimi",
    });

    ensureProfilesFile();
    const data = readJson<ProfilesData>(PROFILES_FILE);
    expect(data.profiles["kimi-dev"]).toEqual({
      model: "kimi-k2-5-coding",
      models: ["kimi-k2-5-coding"],
      token: "sk-test",
      provider: "kimi",
    });
    expect(instanceManager.reserveProxyPortAsync).toHaveBeenCalledWith("kimi-dev");
    expect(profileSyncer.syncNativeProfile).toHaveBeenCalledWith(
      "kimi-dev",
      expect.objectContaining({ provider: "kimi" }),
      "http://127.0.0.1:57001/v1",
    );
  });

  it("updateProfileAction updates profiles.json and syncs native profile", async () => {
    ensureProfilesFile();
    const initial: ProfilesData = {
      profiles: {
        "kimi-dev": {
          model: "kimi-k2-5-coding",
          models: ["kimi-k2-5-coding"],
          provider: "kimi",
          proxyPort: 57001,
        },
      },
    };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(initial, null, 2), "utf-8");

    await updateProfileAction("kimi-dev", {
      token: "sk-updated",
    });

    const data = readJson<ProfilesData>(PROFILES_FILE);
    expect(data.profiles["kimi-dev"].token).toBe("sk-updated");
    expect(profileSyncer.syncNativeProfile).toHaveBeenCalledWith(
      "kimi-dev",
      expect.objectContaining({ token: "sk-updated" }),
      "http://127.0.0.1:57001/v1",
    );
  });

  it("removeProfileAction deletes profile and removes native profile", () => {
    ensureProfilesFile();
    const initial: ProfilesData = {
      profiles: {
        "kimi-dev": {
          model: "kimi-k2-5-coding",
          provider: "kimi",
          proxyPort: 57001,
        },
      },
    };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(initial, null, 2), "utf-8");

    removeProfileAction("kimi-dev");

    const data = readJson<ProfilesData>(PROFILES_FILE);
    expect(data.profiles["kimi-dev"]).toBeUndefined();
    expect(profileSyncer.removeNativeProfile).toHaveBeenCalledWith("kimi-dev");
  });

  it("removeProfileAction removes the active symlink", () => {
    ensureProfilesFile();
    const initial: ProfilesData = {
      profiles: {
        "kimi-dev": {
          model: "kimi-k2-5-coding",
          provider: "kimi",
          proxyPort: 57001,
        },
      },
    };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(initial, null, 2), "utf-8");

    const configPath = profileSyncer.CODEX_CONFIG_FILE;
    const profilePath = profileSyncer.getNativeProfilePath("kimi-dev");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.symlinkSync(profilePath, configPath);
    fs.writeFileSync(profilePath, "profile", "utf-8");

    removeProfileAction("kimi-dev");

    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("renameProfileAction renames profile, removes old native, and syncs new native", async () => {
    ensureProfilesFile();
    const initial: ProfilesData = {
      profiles: {
        "old-name": {
          model: "kimi-k2-5-coding",
          provider: "kimi",
          proxyPort: 57001,
        },
      },
    };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(initial, null, 2), "utf-8");

    renameProfileAction("old-name", "new-name");

    // Wait for the async syncNativeProfile call in rename.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const data = readJson<ProfilesData>(PROFILES_FILE);
    expect(data.profiles["old-name"]).toBeUndefined();
    expect(data.profiles["new-name"]).toEqual({
      model: "kimi-k2-5-coding",
      provider: "kimi",
      proxyPort: 57001,
    });
    expect(profileSyncer.removeNativeProfile).toHaveBeenCalledWith("old-name");
    expect(profileSyncer.syncNativeProfile).toHaveBeenCalledWith(
      "new-name",
      expect.objectContaining({ provider: "kimi" }),
    );
  });

  it("useProfileAction only sets the default profile", () => {
    ensureProfilesFile();
    const initial: ProfilesData = {
      profiles: {
        kimi: { provider: "kimi" },
        cit: { provider: "qianwen" },
      },
    };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(initial, null, 2), "utf-8");

    useProfileAction("cit");

    const data = readJson<ProfilesData>(PROFILES_FILE);
    expect(data.default).toBe("cit");
    expect(profileSyncer.syncNativeProfile).not.toHaveBeenCalled();
    expect(profileSyncer.activateProfileConfig).toBeDefined();
  });

  it("rejects invalid profile names for add", async () => {
    await expect(addProfileAction("invalid name!", {})).rejects.toThrow(
      "invalid characters",
    );
  });

  it("rejects invalid profile names for rename", () => {
    ensureProfilesFile();
    const initial: ProfilesData = {
      profiles: {
        old: { model: "gpt-4", provider: "kimi" },
      },
    };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(initial, null, 2), "utf-8");

    expect(() => renameProfileAction("old", "new name!")).toThrow("invalid characters");
  });
});
