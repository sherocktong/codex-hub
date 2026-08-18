import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import * as logger from "../logger.js";

export interface SessionInfo {
  filePath: string;
  fileName: string;
  sessionId: string;
  startedMs: number;
  cwd: string;
  slug?: string;
  records: number;
  size: number;
  mtimeMs: number;
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseIsoToMs(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const d = new Date(value.replace("Z", "+00:00"));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return undefined;
}

function parseFilenameTimestamp(fileName: string): number | undefined {
  // rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
  const match = fileName.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`);
  return Number.isNaN(dt.getTime()) ? undefined : dt.getTime();
}

function extractSessionIdFromFileName(fileName: string): string | undefined {
  const withoutExt = fileName.replace(/\.jsonl$/, "");
  const parts = withoutExt.split("-");
  const uuid = parts.at(-1);
  return uuid || undefined;
}

function readSessionMeta(filePath: string): {
  sessionId?: string;
  startedMs?: number;
  cwd?: string;
  slug?: string;
  customTitle?: string;
} {
  let result: ReturnType<typeof readSessionMeta> = {};
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);

        // Legacy header shape used by some early Codex CLI builds:
        // { id: "uuid", timestamp: "...", git: { ... } }
        if (d.id && !result.sessionId) {
          result.sessionId = String(d.id);
        }
        if (d.timestamp && result.startedMs === undefined) {
          result.startedMs = parseIsoToMs(d.timestamp);
        }

        // Modern Codex CLI shape:
        // { type: "session_meta", payload: { session_id, cwd, timestamp, ... } }
        const payload = d.type === "session_meta" && typeof d.payload === "object" && d.payload !== null
          ? (d.payload as Record<string, unknown>)
          : undefined;
        if (payload) {
          if (payload.session_id && !result.sessionId) {
            result.sessionId = String(payload.session_id);
          }
          if (payload.timestamp && result.startedMs === undefined) {
            result.startedMs = parseIsoToMs(payload.timestamp);
          }
          if (payload.cwd && !result.cwd) {
            result.cwd = String(payload.cwd);
          }
        }

        // Title / slug records
        if (d.type === "custom-title" && d.customTitle && !result.customTitle) {
          result.customTitle = String(d.customTitle);
        }
        if (d.type === "title" && d.title && !result.slug) {
          result.slug = String(d.title);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // unreadable file
  }
  return result;
}

export function discoverSessions(root: string = SESSIONS_DIR): SessionInfo[] {
  logger.debug(`sessions: discoverSessions root=${root}`);
  const results: SessionInfo[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(fullPath);
          const meta = readSessionMeta(fullPath);
          const fileName = path.basename(fullPath);
          const sessionId = meta.sessionId || extractSessionIdFromFileName(fileName) || fileName.replace(/\.jsonl$/, "");
          const startedMs = meta.startedMs || parseFilenameTimestamp(fileName) || stat.mtimeMs;

          let records = 0;
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            records = content ? content.split("\n").filter((l) => l.trim()).length : 0;
          } catch {
            // ignore
          }

          results.push({
            filePath: fullPath,
            fileName,
            sessionId,
            startedMs,
            cwd: meta.cwd || "",
            slug: meta.customTitle || meta.slug,
            records,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(root);
  return results;
}

export function findSessionByQuery(
  query: string,
  sessions?: SessionInfo[],
): SessionInfo {
  const list = sessions || discoverSessions();
  const q = query.toLowerCase();

  const matches = list.filter((s) => {
    return (
      s.sessionId.toLowerCase().includes(q) ||
      s.fileName.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      (s.slug && s.slug.toLowerCase().includes(q))
    );
  });

  if (matches.length === 0) {
    throw new Error(`Session not found: ${query}`);
  }

  if (matches.length > 1) {
    const lines = matches.map((m) => `  ${m.fileName}  (${m.sessionId})`).join("\n");
    throw new Error(`Multiple sessions matched '${query}':\n${lines}\nUse a longer session id to disambiguate.`);
  }

  return matches[0];
}

export function parseSessionMeta(filePath: string): { started: string; slug: string } {
  const fileName = path.basename(filePath);
  const meta = readSessionMeta(filePath);
  const startedMs = meta.startedMs || parseFilenameTimestamp(fileName);
  return {
    started: startedMs ? formatTimestamp(startedMs) : "?",
    slug: meta.customTitle || meta.slug || "",
  };
}

export function extractText(d: Record<string, unknown>): { role: string; text: string } {
  const message = d.message as Record<string, unknown> | undefined;
  let content: unknown;
  let role = "";

  if (message) {
    content = message.content;
    role = (message.role as string) || "";
  } else {
    content = d.content;
    role = (d.role as string) || (d.type as string) || (d.operation as string) || "";
  }

  // Codex CLI message content is an array of parts: [{ type: "input_text", text }, ...]
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "object" && p !== null) {
        const part = p as Record<string, unknown>;
        if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
          const text = part.text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
    if (parts.length) return { role, text: parts.join("\n") };
  } else if (typeof content === "string") {
    return { role, text: content };
  }
  return { role, text: "" };
}

export function snippet(text: string, query: string, width = 150): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, width);
  const start = Math.max(0, idx - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return prefix + text.slice(start, end) + suffix;
}

export function extractUserMessages(filePath: string, limit = 3): string[] {
  const messages: string[] = [];
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const { role, text } = extractText(d);
        if (text && (role === "user" || d.type === "message")) {
          messages.push(text);
          if (messages.length >= limit) break;
        }
      } catch {
        // skip bad lines
      }
    }
  } catch {
    // skip unreadable files
  }
  return messages;
}
