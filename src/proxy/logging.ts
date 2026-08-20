import fs from "node:fs";
import path from "node:path";
import { getProxyConfigDir } from "./proxy-registry.js";

export function getProxyLogDir(profileName: string): string {
  return path.join(getProxyConfigDir(), "proxy-logs", profileName);
}

export function ensureProxyLogDir(profileName: string): string {
  const dir = getProxyLogDir(profileName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function listLogFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => path.join(dir, name))
    .filter((filePath) => fs.statSync(filePath).isFile());
}

function newestLogFile(dir: string): string | undefined {
  const files = listLogFiles(dir);
  if (files.length === 0) return undefined;

  let newest = files[0];
  let newestMtime = fs.statSync(newest).mtimeMs;
  for (const file of files.slice(1)) {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime > newestMtime) {
      newest = file;
      newestMtime = mtime;
    }
  }
  return newest;
}

export function readProxyLogLines(profileName: string, lineCount: number): string {
  const dir = getProxyLogDir(profileName);
  const file = newestLogFile(dir);
  if (!file) return "";

  const content = fs.readFileSync(file, "utf-8");
  const lines = content.split("\n");
  // If the file ends with a trailing newline, the last element is an empty
  // string; drop it before selecting the most recent lines.
  const nonEmpty = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const start = Math.max(0, nonEmpty.length - lineCount);
  return nonEmpty.slice(start).join("\n");
}

export interface ProxyRequestLogEntry {
  timestamp: string;
  session_id?: string;
  method: string;
  path: string;
  upstream_url: string;
  original_body?: unknown;
  request_body?: unknown;
  response_status?: number;
  response_body?: unknown;
  streaming?: boolean;
  error?: string;
}

export function logProxyRequest(profileName: string, entry: ProxyRequestLogEntry): void {
  const dir = getProxyLogDir(profileName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dir, `requests-${date}.jsonl`);
  const line = JSON.stringify(entry) + "\n";
  try {
    fs.appendFileSync(filePath, line, "utf-8");
  } catch {
    // ignore logging failures
  }
}
