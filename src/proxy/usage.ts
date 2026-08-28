import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RequestContext, TokenUsage } from "./types.js";
import { parseOpenAIUsage } from "./providers/index.js";

const USAGE_LOG_DIR = path.join(os.homedir(), ".codex", "codx");
const USAGE_LOG_FILE = path.join(USAGE_LOG_DIR, "usage.jsonl");

export interface UsageEntry {
  timestamp: string;
  profileName: string;
  providerId: string;
  providerName: string;
  model?: string;
  path: string;
  method: string;
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
  durationMs: number;
  attempt: number;
  sessionId?: string;
}

function ensureUsageLogDir(): void {
  if (!fs.existsSync(USAGE_LOG_DIR)) {
    fs.mkdirSync(USAGE_LOG_DIR, { recursive: true });
  }
}

export function computeCost(
  providerId: string,
  usage: TokenUsage,
): number | undefined {
  // Pricing is highly provider/model-specific and changes frequently.
  // Keep a small set of fallback rates for convenience; prefer explicit
  // provider pricing once configurable rates are added.
  const rates: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
    kimi: { input: 0.07, output: 0.3, cacheRead: 0.035, cacheWrite: 0.07 },
    qianwen: { input: 1.2, output: 1.2, cacheRead: 0.6, cacheWrite: 1.2 },
  };

  const rate = rates[providerId];
  if (!rate) return undefined;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  const nonCacheInput = Math.max(0, usage.inputTokens - cacheRead - cacheCreation);

  const cost =
    (nonCacheInput * rate.input +
      usage.outputTokens * rate.output +
      cacheRead * rate.cacheRead +
      cacheCreation * rate.cacheWrite) /
    1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

async function parseResponseUsage(response: Response): Promise<TokenUsage | undefined> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }
  try {
    const cloned = response.clone();
    const data = await cloned.json();
    return parseOpenAIUsage(data);
  } catch {
    return undefined;
  }
}

/**
 * Extract token usage from a single streaming event. Supports both the Codex
 * Responses API (`response.completed` with `input_tokens/output_tokens`) and the
 * OpenAI Chat Completions format (`usage.prompt_tokens/completion_tokens`).
 */
export function extractStreamUsage(event: Record<string, unknown>): TokenUsage | undefined {
  const eventType = typeof event.type === "string" ? event.type : undefined;
  const response = (event.response as Record<string, unknown>) ?? {};
  let usage: Record<string, unknown> | undefined;

  if (eventType === "response.completed" && response.usage) {
    usage = response.usage as Record<string, unknown>;
  } else if (event.usage) {
    usage = event.usage as Record<string, unknown>;
  }

  if (!usage) {
    return undefined;
  }

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  if (typeof usage.input_tokens === "number") {
    inputTokens = usage.input_tokens;
    outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  } else if (typeof usage.prompt_tokens === "number") {
    inputTokens = usage.prompt_tokens;
    outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  }

  if (inputTokens === undefined || (inputTokens === 0 && outputTokens === 0)) {
    return undefined;
  }

  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  if (inputDetails) {
    if (typeof inputDetails.cached_tokens === "number") cacheReadTokens = inputDetails.cached_tokens;
    if (typeof inputDetails.cache_write_tokens === "number") cacheCreationTokens = inputDetails.cache_write_tokens;
  }
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  if (promptDetails) {
    if (typeof promptDetails.cached_tokens === "number") cacheReadTokens = promptDetails.cached_tokens;
    if (typeof promptDetails.cache_write_tokens === "number") cacheCreationTokens = promptDetails.cache_write_tokens;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

export async function logRequest(
  ctx: RequestContext,
  response: Response,
  usage?: TokenUsage,
): Promise<void> {
  const streamed = !!ctx.body.stream;
  const resolvedUsage = usage ?? (await parseResponseUsage(response));
  const durationMs = Date.now() - ctx.startTime;

  const entry: UsageEntry = {
    timestamp: new Date().toISOString(),
    profileName: ctx.profileName,
    providerId: ctx.provider.id,
    providerName: ctx.provider.name,
    model: typeof ctx.body.model === "string" ? ctx.body.model : undefined,
    path: ctx.path,
    method: ctx.method,
    streamed,
    inputTokens: resolvedUsage?.inputTokens ?? 0,
    outputTokens: resolvedUsage?.outputTokens ?? 0,
    cacheReadTokens: resolvedUsage?.cacheReadTokens ?? 0,
    cacheCreationTokens: resolvedUsage?.cacheCreationTokens ?? 0,
    costUsd: resolvedUsage ? computeCost(ctx.provider.id, resolvedUsage) : undefined,
    durationMs,
    attempt: ctx.attempt,
    sessionId: ctx.sessionId,
  };

  ensureUsageLogDir();
  fs.appendFileSync(USAGE_LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
}
