import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as logger from "./logger.js";

export const CODEX_DIR = process.env.CODEX_DIR || path.join(os.homedir(), ".codex");
export const PROFILES_FILE = process.env.CODEX_PROFILES_FILE || path.join(CODEX_DIR, "profiles.json");
export const SETTINGS_FILE = process.env.CODEX_SETTINGS_FILE || path.join(CODEX_DIR, "settings.json");
export const PROJECTS_DIR = path.join(CODEX_DIR, "projects");
export const SESSIONS_DIR = path.join(CODEX_DIR, "sessions");

export function ensureFile(filePath: string, defaultContent: string): void {
  if (!fs.existsSync(filePath)) {
    logger.debug(`ensureFile: creating ${filePath}`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, defaultContent, "utf-8");
  }
}

export function readJson<T = unknown>(filePath: string): T {
  logger.debug(`readJson: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function writeJson(filePath: string, data: unknown): void {
  logger.debug(`writeJson: ${filePath}`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function ensureProfilesFile(): void {
  ensureFile(PROFILES_FILE, '{"profiles":{}}\n');
}

export function ensureSettingsFile(): void {
  ensureFile(SETTINGS_FILE, "{}\n");
}

/**
 * Validate a JSON file and auto-correct if invalid.
 * If valid, backs it up to ~/.codex/ for restore on fix failure.
 * If invalid and fixable, writes the corrected text back.
 * If invalid and unfixable, restores from backup (or writes fallback).
 * No-op if the file doesn't exist.
 */
export function fixJsonFile(filePath: string, fallback: Record<string, unknown> = {}): void {
  if (!fs.existsSync(filePath)) return;

  const backupPath = path.join(CODEX_DIR, path.basename(filePath) + ".backup");
  const raw = fs.readFileSync(filePath, "utf-8");

  // Try normal parse — if valid, back it up
  try {
    JSON.parse(raw);
    fs.mkdirSync(CODEX_DIR, { recursive: true });
    fs.copyFileSync(filePath, backupPath);
    return;
  } catch {
    // fall through to recovery
  }

  let text = raw.trim();

  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1).trim();
  }

  // Remove trailing comma at end of file
  text = text.replace(/,\s*$/, "");

  // Remove trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, "$1");

  // Strip content after the last closing brace/bracket
  const lastBrace = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (lastBrace !== -1 && lastBrace < text.length - 1) {
    text = text.slice(0, lastBrace + 1);
  }

  // Auto-close unbalanced braces/brackets
  let openCurly = 0, openSquare = 0;
  for (const ch of text) {
    if (ch === "{") openCurly++;
    else if (ch === "}") openCurly--;
    else if (ch === "[") openSquare++;
    else if (ch === "]") openSquare--;
  }
  if (openSquare > 0) text += "]".repeat(openSquare);
  if (openCurly > 0) text += "}".repeat(openCurly);

  // Try parse after fixes
  try {
    JSON.parse(text);
    fs.writeFileSync(filePath, text + "\n", "utf-8");
    logger.warn(`Fixed invalid JSON in ${path.basename(filePath)}.`);
    console.error(`Fixed invalid JSON in ${path.basename(filePath)}.`);
  } catch {
    // Unrecoverable — restore backup or write fallback
    let restored = false;
    if (fs.existsSync(backupPath)) {
      try {
        const backupRaw = fs.readFileSync(backupPath, "utf-8");
        JSON.parse(backupRaw);
        fs.copyFileSync(backupPath, filePath);
        restored = true;
        logger.warn(`Restored ${path.basename(filePath)} from backup.`);
        console.error(`Restored ${path.basename(filePath)} from backup.`);
      } catch {
        logger.error(`Backup ${path.basename(backupPath)} is also corrupt; using fallback.`);
        console.error(`Backup ${path.basename(backupPath)} is also corrupt; using fallback.`);
      }
    }
    if (!restored) {
      writeJson(filePath, fallback);
      logger.error(`Could not fix ${path.basename(filePath)}, no valid backup found, reset to default.`);
      console.error(`Could not fix ${path.basename(filePath)}, no valid backup found, reset to default.`);
    }
  }
}
