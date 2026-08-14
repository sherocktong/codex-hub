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

export async function logRequest(ctx: RequestContext, response: Response): Promise<void> {
  const streamed = !!ctx.body.stream;
  const usage = await parseResponseUsage(response);
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
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
    costUsd: usage ? computeCost(ctx.provider.id, usage) : undefined,
    durationMs,
    attempt: ctx.attempt,
    sessionId: ctx.sessionId,
  };

  ensureUsageLogDir();
  fs.appendFileSync(USAGE_LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
}
