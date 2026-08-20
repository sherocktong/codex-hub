import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), `codx-model-catalog-test-${process.pid}`);
process.env.CODEX_HOME = TEST_DIR;
process.env.CODEX_DIR = TEST_DIR;
process.env.CODX_PROXY_CONFIG_DIR = TEST_DIR;

const catalog = await import("../src/profiles/model-catalog.js");
const profileSyncer = await import("../src/profiles/profile-syncer.js");

describe("model-catalog", () => {
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

  it("buildModelInfo fills required ModelInfo fields with picker-safe defaults", () => {
    const info = catalog.buildModelInfo("kimi-k2-6", 1, 258400);
    expect(info.slug).toBe("kimi-k2-6");
    expect(info.display_name).toBe("kimi-k2-6");
    expect(info.visibility).toBe("list");
    expect(info.supported_in_api).toBe(true);
    expect(info.priority).toBe(1);
    expect(info.shell_type).toBe("shell_command");
    expect(info.support_verbosity).toBe(false);
    expect(info.supported_reasoning_levels.length).toBeGreaterThan(0);
    expect(info.default_reasoning_level).toBe("medium");
    expect(info.truncation_policy).toEqual({ mode: "tokens", limit: 10000 });
    expect(info.experimental_supported_tools).toEqual([]);
    expect(info.context_window).toBe(258400);
    expect(info.max_context_window).toBe(258400);
    expect(info.input_modalities).toEqual(["text"]);
    expect(info.supports_parallel_tool_calls).toBe(false);
    expect(info.base_instructions).toBe("");
  });

  it("buildModelCatalog only lists profile models, using provider type for context window", () => {
    const result = catalog.buildModelCatalog(["kimi-k2-7", "kimi-k2-6"], {
      id: "kimi",
      type: "kimi",
      name: "Kimi",
      baseUrl: "https://api.kimi.com/coding",
      apiKey: "",
      models: ["kimi-k2-6", "kimi-k3"],
    });
    expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2-7", "kimi-k2-6"]);
    expect(result.models.map((m) => m.priority)).toEqual([1, 2]);
    expect(result.models[0].context_window).toBe(258400);
  });

  it("buildModelCatalog without a provider omits context window", () => {
    const result = catalog.buildModelCatalog(["my-model"]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0].context_window).toBeUndefined();
  });

  it("writeModelCatalog writes a ModelsResponse parseable from disk", () => {
    const filePath = catalog.writeModelCatalog("kimi-dev", catalog.buildModelCatalog(["kimi-k2-6"]));
    expect(filePath).toBe(path.join(TEST_DIR, "catalogs", "kimi-dev.models.json"));
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].slug).toBe("kimi-k2-6");
  });

  it("writeModelCatalog rejects an empty catalog", () => {
    expect(() => catalog.writeModelCatalog("empty", { models: [] })).toThrow();
  });

  it("syncNativeProfile injects model_catalog_json pointing at the generated catalog", async () => {
    await profileSyncer.syncNativeProfile(
      "kimi-dev",
      { models: ["kimi-k2-6", "kimi-k2-7"], provider: "kimi" },
      "http://127.0.0.1:1234/v1",
    );
    const content = fs.readFileSync(profileSyncer.getNativeProfilePath("kimi-dev"), "utf-8");
    const expectedPath = path.join(TEST_DIR, "catalogs", "kimi-dev.models.json");
    expect(content).toContain(`model_catalog_json = "${expectedPath}"`);
    expect(fs.existsSync(expectedPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
    expect(parsed.models[0].slug).toBe("kimi-k2-6");
  });

  it("syncNativeProfile strips a stale model_catalog_json when no models remain", async () => {
    await profileSyncer.syncNativeProfile(
      "plain",
      { models: ["kimi-k2-6"], provider: "kimi" },
      "http://127.0.0.1:1234/v1",
    );
    const catalogPath = path.join(TEST_DIR, "catalogs", "plain.models.json");
    expect(fs.existsSync(catalogPath)).toBe(true);

    await profileSyncer.syncNativeProfile("plain", {}, "http://127.0.0.1:1234/v1");
    const content = fs.readFileSync(profileSyncer.getNativeProfilePath("plain"), "utf-8");
    expect(content).not.toContain("model_catalog_json");
    expect(fs.existsSync(catalogPath)).toBe(false);
  });

  it("removeNativeProfile removes the generated catalog file", async () => {
    await profileSyncer.syncNativeProfile(
      "gone",
      { models: ["kimi-k2-6"], provider: "kimi" },
      "http://127.0.0.1:1234/v1",
    );
    const catalogPath = path.join(TEST_DIR, "catalogs", "gone.models.json");
    expect(fs.existsSync(catalogPath)).toBe(true);
    profileSyncer.removeNativeProfile("gone");
    expect(fs.existsSync(catalogPath)).toBe(false);
  });
});
