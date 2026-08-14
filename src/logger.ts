import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOG_DIR = path.join(os.homedir(), ".codex", "codx", "logs");

const LEVEL_PRIORITY: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let currentLevel = "INFO";

export function setLogLevel(level: string): void {
  const upper = level.toUpperCase();
  if (upper in LEVEL_PRIORITY) {
    currentLevel = upper;
  }
}

function shouldLog(level: string): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `codx-${date}.log`);
}

function formatLine(level: string, message: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] ${message}\n`;
}

function write(level: string, message: string, err?: unknown): void {
  if (!shouldLog(level)) return;
  ensureLogDir();
  let line = formatLine(level, message);
  if (err instanceof Error) {
    line += formatLine(level, err.stack || err.message);
  } else if (err !== undefined) {
    line += formatLine(level, String(err));
  }
  try {
    fs.appendFileSync(logFilePath(), line, "utf-8");
  } catch {
    // ignore logging failures
  }
}

export function error(message: string, err?: unknown): void {
  write("ERROR", message, err);
}

export function warn(message: string, err?: unknown): void {
  write("WARN", message, err);
}

export function info(message: string): void {
  write("INFO", message);
}

export function debug(message: string): void {
  write("DEBUG", message);
}

export function installGlobalExceptionHandlers(): void {
  process.on("uncaughtException", (err) => {
    error("Uncaught exception", err);
    console.error("Unexpected error:", err.message);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    error("Unhandled rejection", reason instanceof Error ? reason : new Error(String(reason)));
    console.error("Unhandled promise rejection:", reason);
    process.exit(1);
  });
}

export function safeAction<T extends (...args: any[]) => any>(fn: T): T {
  return ((...args: any[]) => {
    info(`Executing: ${process.argv.slice(2).join(" ")}`);
    try {
      const result = fn(...args);
      if (result && typeof result.then === "function") {
        return (result as Promise<any>).catch((err: unknown) => {
          error(`Command failed: ${err instanceof Error ? err.message : String(err)}`, err);
          console.error("Error:", err instanceof Error ? err.message : String(err));
          process.exit(1);
        });
      }
      return result;
    } catch (err) {
      error(`Command failed: ${err instanceof Error ? err.message : String(err)}`, err);
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }) as T;
}
