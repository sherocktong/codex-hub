import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), `codx-profile-syncer-test-${process.pid}`);
process.env.CODEX_HOME = TEST_DIR;
process.env.CODEX_DIR = TEST_DIR;
process.env.CODX_PROXY_CONFIG_DIR = TEST_DIR;

const profileSyncer = await import("../src/profiles/profile-syncer.js");
const proxyConfig = await import("../src/proxy/config.js");

describe("profile-syncer", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns the native profile path under CODEX_HOME", () => {
    const filePath = profileSyncer.getNativeProfilePath("kimi-dev");
    expect(filePath).toBe(path.join(TEST_DIR, "kimi-dev.config.toml"));
  });

  it("escapes TOML string special characters", () => {
    expect(profileSyncer.escapeTomlString('say "hello"')).toBe('say \\"hello\\"');
    expect(profileSyncer.escapeTomlString("c:\\path\\to\\file")).toBe("c:\\\\path\\\\to\\\\file");
  });

  it("generateDefaultBaseConfig contains mcp_servers, features, and context limits", () => {
    const content = profileSyncer.generateDefaultBaseConfig();
    expect(content).toContain("[mcp_servers.node_repl]");
    expect(content).toContain("[mcp_servers.computer-use]");
    expect(content).toContain("[features]");
    expect(content).toContain("[marketplaces.openai-bundled]");
    expect(content).toContain('theme = "Catppuccin Latte"');
    expect(content).toContain("model_context_window = 258400");
    expect(content).toContain("remote_compaction_v2 = false");
  });

  it("syncs native profile file with multiple models", () => {
    const filePath = profileSyncer.getNativeProfilePath("multi-model");
    profileSyncer.syncNativeProfile(
      "multi-model",
      {
        models: ["kimi-k2-6", "kimi-k2-7", "kimi-k2-5-coding"],
        provider: "kimi",
      },
      "http://127.0.0.1:1234/v1",
    );

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain('model = "kimi-k2-6"');
    expect(content).toContain(
      'models = ["kimi-k2-6", "kimi-k2-7", "kimi-k2-5-coding"]',
    );
    expect(content).toContain("model_context_window = 262144");
  });

  it("syncs native profile file with an explicit URL", () => {
    const filePath = profileSyncer.getNativeProfilePath("kimi-dev");
    profileSyncer.syncNativeProfile("kimi-dev", {
      models: ["kimi-k2-5-coding"],
      provider: "kimi",
    }, "http://127.0.0.1:1234/v1");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain('model_provider = "openai"');
    expect(content).toContain('openai_base_url = "http://127.0.0.1:1234/v1"');
    expect(content).toContain('model = "kimi-k2-5-coding"');
    expect(content).toContain('models = ["kimi-k2-5-coding"]');
    expect(content).toContain("model_context_window = 262144");
    expect(content).toContain("[features]");
    expect(content).toContain("remote_compaction_v2 = false");
    expect(content).not.toContain("[mcp_servers.node_repl]");
  });

  it("syncs native profile without inheriting project nodes from config.toml", () => {
    const configPath = profileSyncer.CODEX_CONFIG_FILE;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      '[projects."/Users/kangtong/work"]\ntrust_level = "trusted"\n',
      "utf-8",
    );

    const filePath = profileSyncer.getNativeProfilePath("kimi-dev");
    profileSyncer.syncNativeProfile("kimi-dev", {
      models: ["kimi-k2-5-coding"],
      provider: "kimi",
    }, "http://127.0.0.1:1234/v1");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).not.toContain('[projects."/Users/kangtong/work"]');
    expect(content).toContain('openai_base_url = "http://127.0.0.1:1234/v1"');
    expect(content).toContain('models = ["kimi-k2-5-coding"]');
    expect(content).toContain("remote_compaction_v2 = false");
  });

  it("syncs native profile deriving URL from persisted proxy port", () => {
    const filePath = profileSyncer.getNativeProfilePath("port-profile");
    const proxyConfigData = proxyConfig.readProxyConfig();
    profileSyncer.syncNativeProfile("port-profile", {
      models: ["qwen-max"],
      provider: "qianwen",
      proxyPort: 57042,
    });

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain(`openai_base_url = "http://${proxyConfigData.listenAddress}:57042/v1"`);
    expect(content).toContain('models = ["qwen-max"]');
    expect(content).toContain("model_context_window = 64000");
  });

  it("reserves a proxy port when syncing without URL or persisted port", async () => {
    const filePath = profileSyncer.getNativeProfilePath("new-profile");
    fs.writeFileSync(
      path.join(TEST_DIR, "profiles.json"),
      JSON.stringify({ profiles: { "new-profile": { provider: "qianwen" } } }, null, 2),
      "utf-8",
    );

    await profileSyncer.syncNativeProfile("new-profile", {
      models: ["qwen-max"],
      provider: "qianwen",
    });

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toMatch(/openai_base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    expect(content).toContain('models = ["qwen-max"]');
  });

  it("syncs native profile falling back to singular model when models is absent", () => {
    const filePath = profileSyncer.getNativeProfilePath("singular-model");
    profileSyncer.syncNativeProfile(
      "singular-model",
      {
        model: "kimi-k2-5-coding",
        provider: "kimi",
      },
      "http://127.0.0.1:1234/v1",
    );

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain('model = "kimi-k2-5-coding"');
    expect(content).toContain('models = ["kimi-k2-5-coding"]');
  });

  it("preserves existing profile file contents while updating routing keys", () => {
    const filePath = profileSyncer.getNativeProfilePath("preserve");
    fs.writeFileSync(
      filePath,
      'theme = "Catppuccin Frappe"\n[projects."/Users/kangtong/work"]\ntrust_level = "trusted"\n',
      "utf-8",
    );

    profileSyncer.syncNativeProfile(
      "preserve",
      {
        models: ["kimi-k2-7"],
        provider: "kimi",
      },
      "http://127.0.0.1:1234/v1",
    );

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain('theme = "Catppuccin Frappe"');
    expect(content).toContain('[projects."/Users/kangtong/work"]');
    expect(content).toContain('trust_level = "trusted"');
    expect(content).toContain('model_provider = "openai"');
    expect(content).toContain('openai_base_url = "http://127.0.0.1:1234/v1"');
    expect(content).toContain('models = ["kimi-k2-7"]');
  });

  it("overwrites stale routing keys in existing profile file", () => {
    const filePath = profileSyncer.getNativeProfilePath("update");
    fs.writeFileSync(
      filePath,
      'model_provider = "openai"\nopenai_base_url = "http://old.example/v1"\nmodel = "old-model"\n',
      "utf-8",
    );

    profileSyncer.syncNativeProfile(
      "update",
      {
        models: ["kimi-k2-7"],
        provider: "kimi",
      },
      "http://127.0.0.1:1234/v1",
    );

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain('openai_base_url = "http://127.0.0.1:1234/v1"');
    expect(content).toContain('models = ["kimi-k2-7"]');
    expect(content).not.toContain("http://old.example/v1");
    expect(content).not.toContain('model = "old-model"');
  });

  it("removes a native profile file", () => {
    const filePath = profileSyncer.getNativeProfilePath("to-remove");
    fs.writeFileSync(filePath, "test", "utf-8");
    profileSyncer.removeNativeProfile("to-remove");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("removing a missing native profile does not throw", () => {
    expect(() => profileSyncer.removeNativeProfile("missing")).not.toThrow();
  });

  it("activateProfileConfig merges profile into base config.toml", () => {
    const configPath = profileSyncer.CODEX_CONFIG_FILE;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      '[projects."/Users/kangtong/work"]\ntrust_level = "trusted"\n',
      "utf-8",
    );

    profileSyncer.activateProfileConfig("active", { provider: "kimi" }, "http://127.0.0.1:1234/v1");

    expect(fs.lstatSync(configPath).isFile()).toBe(true);
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(false);
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain('model_provider = "openai"');
    expect(content).toContain('openai_base_url = "http://127.0.0.1:1234/v1"');
    expect(content).toContain('[projects."/Users/kangtong/work"]');
    expect(content).toContain('trust_level = "trusted"');
    expect(content).not.toContain('# Generated by codex-hub for profile');
  });

  it("activateProfileConfig merges multiple models into base config.toml", () => {
    const configPath = profileSyncer.CODEX_CONFIG_FILE;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    profileSyncer.activateProfileConfig(
      "multi",
      {
        provider: "kimi",
        models: ["kimi-k2-6", "kimi-k2-7"],
      },
      "http://127.0.0.1:1234/v1",
    );

    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain('model = "kimi-k2-6"');
    expect(content).toContain('models = ["kimi-k2-6", "kimi-k2-7"]');
    expect(content).toContain('model_provider = "openai"');
    expect(content).toContain('openai_base_url = "http://127.0.0.1:1234/v1"');
  });

  it("activateProfileConfig replaces an existing symlink with a regular file and merges", () => {
    const configPath = profileSyncer.CODEX_CONFIG_FILE;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.symlinkSync(profileSyncer.getNativeProfilePath("old"), configPath);
    fs.writeFileSync(profileSyncer.getNativeProfilePath("old"), "old", "utf-8");
    fs.writeFileSync(
      configPath,
      '[projects."/Users/kangtong/work"]\ntrust_level = "trusted"\n',
      "utf-8",
    );

    profileSyncer.activateProfileConfig("new", { provider: "kimi" }, "http://127.0.0.1:1234/v1");

    expect(fs.lstatSync(configPath).isFile()).toBe(true);
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(false);
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain('model_provider = "openai"');
    expect(content).toContain('[projects."/Users/kangtong/work"]');
    expect(content).toContain('trust_level = "trusted"');
  });

  it("deactivateProfileConfig preserves base config.toml", () => {
    const configPath = profileSyncer.CODEX_CONFIG_FILE;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    profileSyncer.activateProfileConfig("active", { provider: "kimi" }, "http://127.0.0.1:1234/v1");
    expect(fs.existsSync(configPath)).toBe(true);

    profileSyncer.deactivateProfileConfig("active");
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("mergeTomlContents overwrites duplicate keys with profile values", () => {
    const merged = profileSyncer.mergeTomlContents(
      'model_provider = "old"\nopenai_base_url = "http://old.example/v1"\n',
      'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:1234/v1"\n',
    );
    expect(merged).toContain('model_provider = "openai"');
    expect(merged).toContain('openai_base_url = "http://127.0.0.1:1234/v1"');
    expect(merged).not.toContain('model_provider = "old"');
  });

  it("mergeTomlContents preserves base-only entries", () => {
    const merged = profileSyncer.mergeTomlContents(
      '[projects."/Users/kangtong/work"]\ntrust_level = "trusted"\n',
      'model_provider = "openai"\n',
    );
    expect(merged).toContain('[projects."/Users/kangtong/work"]');
    expect(merged).toContain('trust_level = "trusted"');
    expect(merged).toContain('model_provider = "openai"');
  });

  it("mergeTomlContents merges table keys with profile winning", () => {
    const merged = profileSyncer.mergeTomlContents(
      "[features]\njs_repl = false\nremote_compaction_v2 = true\n",
      "[features]\nremote_compaction_v2 = false\n",
    );
    expect(merged).toContain("js_repl = false");
    expect(merged).toContain("remote_compaction_v2 = false");
    expect(merged).not.toContain("remote_compaction_v2 = true");
  });

  it("mergeTomlContents appends profile-only tables", () => {
    const merged = profileSyncer.mergeTomlContents(
      "[features]\njs_repl = false\n",
      "[shell_environment_policy.set]\nBROWSER_USE_AVAILABLE_BACKENDS = \"chrome,iab\"\n",
    );
    expect(merged).toContain("[features]");
    expect(merged).toContain("js_repl = false");
    expect(merged).toContain("[shell_environment_policy.set]");
    expect(merged).toContain('BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"');
  });
});
