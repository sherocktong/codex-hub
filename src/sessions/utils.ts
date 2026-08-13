import fs from "node:fs";
import path from "node:path";
import { PROJECTS_DIR } from "../config.js";
import { encodePath, decodePath } from "./codec.js";
import * as logger from "../logger.js";

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function findProjectDir(query: string): string | null {
  logger.debug(`sessions: findProjectDir query="${query}"`);
  const encoded = encodePath(query);
  if (fs.existsSync(path.join(PROJECTS_DIR, encoded))) {
    logger.debug(`sessions: findProjectDir exact match ${encoded}`);
    return encoded;
  }

  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    const match = dirs.find((d) => d.toLowerCase().includes(query.toLowerCase()));
    if (match) logger.debug(`sessions: findProjectDir partial match ${match}`);
    return match || null;
  } catch {
    return null;
  }
}

export function parseSessionMeta(filePath: string): { started: string; slug: string } {
  let started = "?";
  let slug = "";
  let customTitle = "";
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (started === "?") {
          const ts = d.timestamp;
          if (ts) {
            const dt = typeof ts === "number"
              ? new Date(ts)
              : new Date(String(ts).replace("Z", "+00:00"));
            started = formatTimestamp(dt.getTime());
          }
        }
        if (!slug) slug = d.slug || "";
        if (d.type === "custom-title") customTitle = d.customTitle || "";
      } catch { /* skip bad lines */ }
    }
  } catch { /* skip unreadable files */ }
  return { started, slug: customTitle || slug };
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
    role = (d.type as string) || (d.operation as string) || "";
  }

  if (Array.isArray(content)) {
    for (const p of content) {
      if (typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text") {
        return { role, text: (p as Record<string, unknown>).text as string };
      }
    }
  } else if (typeof content === "string") {
    return { role, text: content };
  }
  return { role: "", text: "" };
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

export function findSessionFile(
  sessionQuery: string,
  projectQuery?: string,
): { filePath: string; project: string } | null {
  logger.debug(`sessions: findSessionFile query="${sessionQuery}" project=${projectQuery || "(any)"}`);

  let searchDirs: string[] = [];

  if (projectQuery) {
    const projDir = findProjectDir(projectQuery);
    if (!projDir) {
      throw new Error(`No project matched: ${projectQuery}`);
    }
    searchDirs.push(path.join(PROJECTS_DIR, projDir));
  } else {
    try {
      searchDirs = fs.readdirSync(PROJECTS_DIR).map((d) => path.join(PROJECTS_DIR, d));
    } catch {
      throw new Error(`No projects directory found at ${PROJECTS_DIR}`);
    }
  }

  const matches: Array<{ filePath: string; project: string }> = [];

  for (const dir of searchDirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, "");
      if (sessionId.toLowerCase().includes(sessionQuery.toLowerCase())) {
        matches.push({ filePath: path.join(dir, file), project: path.basename(dir) });
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    const lines = matches.map((m) => `  ${path.basename(m.filePath)} in ${decodePath(m.project)}`).join("\n");
    throw new Error(`Multiple sessions matched '${sessionQuery}':\n${lines}\nUse --project to disambiguate.`);
  }

  return matches[0];
}
