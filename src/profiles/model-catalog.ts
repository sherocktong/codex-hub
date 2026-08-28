import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProviderConfig } from "../types.js";
import * as logger from "../logger.js";

export interface ReasoningLevel {
  effort: string;
  description: string;
}

export interface TruncationPolicy {
  mode: "tokens" | "bytes";
  limit: number;
}

export interface ModelInfo {
  slug: string;
  display_name: string;
  description: string;
  visibility: "list" | "hidden";
  supported_in_api: boolean;
  priority: number;
  shell_type: string;
  support_verbosity: boolean;
  supported_reasoning_levels: ReasoningLevel[];
  default_reasoning_level: string;
  truncation_policy: TruncationPolicy;
  experimental_supported_tools: string[];
  context_window?: number;
  max_context_window?: number;
  input_modalities: string[];
  supports_parallel_tool_calls: boolean;
  base_instructions: string;
}

export interface ModelsResponse {
  models: ModelInfo[];
}

interface ModelContextWindow {
  slug: string;
  contextWindow: number;
}

/**
 * Per-model context windows. Exact model slugs take precedence over the
 * provider fallbacks in DEFAULT_CONTEXT_WINDOWS below.
 */
const MODEL_CONTEXT_WINDOWS: readonly ModelContextWindow[] = [
  // Kimi K2.x series: 256K tokens
  // Kimi K3: advertised as 1M, but the default Kimi Code tier (Moderato)
  // exposes a 256K effective window. Use 256K so context remaining stays
  // meaningful; users on the 1M Allegretto+ tier can override via provider
  // config if a future override option is added.
  { slug: "kimi-k3", contextWindow: 1048576 },
  // Qianwen / Qwen 3.8 Max Preview: use the full 256K advertised window.
  { slug: "qwen3.8-max-preview", contextWindow: 1000000 },
  // Qianwen / Qwen Max: keep the previously tested 64K effective window so
  // context remaining stays meaningful in the Codex TUI.
  { slug: "qwen-max", contextWindow: 64000 },
];

const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  kimi: 262144,
  qianwen: 128000,
};

function getContextWindow(slug: string, providerType?: string): number | undefined {
  const match = MODEL_CONTEXT_WINDOWS.find((entry) => entry.slug === slug);
  if (match) {
    return match.contextWindow;
  }
  if (providerType) {
    return DEFAULT_CONTEXT_WINDOWS[providerType];
  }
  return undefined;
}

function getCatalogDir(): string {
  const base = process.env.CODX_PROXY_CONFIG_DIR || path.join(os.homedir(), ".codex", "codx");
  return path.join(base, "catalogs");
}

export function getModelCatalogPath(profileName: string): string {
  return path.join(getCatalogDir(), `${profileName}.models.json`);
}

export function buildModelInfo(
  slug: string,
  priority: number,
  contextWindow?: number,
): ModelInfo {
  const info: ModelInfo = {
    slug,
    display_name: slug,
    description: `Model '${slug}' served by the codx provider proxy.`,
    visibility: "list",
    supported_in_api: true,
    priority,
    shell_type: "shell_command",
    support_verbosity: false,
    supported_reasoning_levels: [
      { effort: "medium", description: "Balances speed and reasoning depth" },
    ],
    default_reasoning_level: "medium",
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_parallel_tool_calls: false,
    base_instructions: "",
  };
  if (contextWindow !== undefined) {
    info.context_window = contextWindow;
    info.max_context_window = contextWindow;
  }
  return info;
}

/**
 * Build a ModelsResponse catalog for the Codex `/model` picker. Profile models
 * come first (in profile order, so models[0] is the default), followed by any
 * remaining provider preset models.
 */
export function buildModelCatalog(
  profileModels: string[],
  provider?: ProviderConfig,
): ModelsResponse {
  const slugs: string[] = [];
  for (const slug of profileModels) {
    if (!slugs.includes(slug)) {
      slugs.push(slug);
    }
  }
  return {
    models: slugs.map((slug, index) => {
      const contextWindow = provider ? getContextWindow(slug, provider.type) : getContextWindow(slug);
      return buildModelInfo(slug, index + 1, contextWindow);
    }),
  };
}

/**
 * Write the catalog atomically and return its absolute path. The file is
 * referenced from the profile config via `model_catalog_json`.
 */
export function writeModelCatalog(profileName: string, catalog: ModelsResponse): string {
  if (catalog.models.length === 0) {
    throw new Error("Model catalog must contain at least one model.");
  }
  const filePath = getModelCatalogPath(profileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(catalog, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
  logger.debug(`writeModelCatalog: wrote ${filePath} (${catalog.models.length} model(s))`);
  return filePath;
}

export function removeModelCatalog(profileName: string): void {
  const filePath = getModelCatalogPath(profileName);
  try {
    fs.unlinkSync(filePath);
    logger.debug(`removeModelCatalog: removed ${filePath}`);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.warn(`failed to remove model catalog '${filePath}'`, err);
    }
  }
}
