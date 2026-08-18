import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SESSIONS_DIR, CODEX_DIR } from "../config.js";
import { getDirSize, formatSize } from "./stats.js";
import {
  formatTimestamp,
  parseSessionMeta,
  extractText,
  snippet,
  discoverSessions,
  findSessionByQuery,
  extractUserMessages,
  type SessionInfo,
} from "./utils.js";
import { safeAction } from "../logger.js";
import * as logger from "../logger.js";

export function sessionCommand(): Command {
  const session = new Command("session")
    .description("Manage Codex CLI sessions");

  // --- list ---
  session
    .command("list")
    .description("List all Codex CLI project sessions")
    .option("-n, --limit <n>", "Max number of sessions to show", "30")
    .option("-s, --short", "Show session ids only")
    .option("-j, --json", "Output as JSON lines")
    .action(safeAction((opts: { limit: string; short?: boolean; json?: boolean }) => {
      logger.debug(`session list: scanning ${SESSIONS_DIR}, limit=${opts.limit}`);
      const limit = parseInt(opts.limit, 10);
      const sessions = discoverSessions(SESSIONS_DIR).sort((a, b) => b.mtimeMs - a.mtimeMs);

      if (sessions.length === 0) {
        console.log("No sessions found.");
        return;
      }

      let count = 0;
      for (const s of sessions) {
        if (count >= limit) break;

        if (opts.json) {
          console.log(JSON.stringify({
            sessionId: s.sessionId,
            file: s.fileName,
            cwd: s.cwd,
            records: s.records,
            started: Math.floor(s.startedMs),
            modified: Math.floor(s.mtimeMs),
          }));
        } else if (opts.short) {
          console.log(s.sessionId);
        } else {
          const started = formatTimestamp(s.startedMs);
          const cwd = s.cwd.length > 40 ? "..." + s.cwd.slice(-37) : s.cwd || "-";
          console.log(`${started}  ${s.sessionId.padEnd(36)}  ${cwd.padEnd(42)}  ${String(s.records).padStart(4)} records`);
        }
        count++;
      }
    }));

  // --- show ---
  session
    .command("show")
    .description("Show session files for a project")
    .argument("<session>", "Session ID, partial UUID, or rollout filename")
    .option("-v, --verbose", "Show first user messages of the session")
    .action(safeAction((sessionQuery: string, opts: { verbose?: boolean }) => {
      logger.debug(`session show: query=${sessionQuery} verbose=${!!opts.verbose}`);
      const s = findSessionByQuery(sessionQuery);

      console.log(`Session: ${s.sessionId}`);
      console.log(`File:    ${s.fileName}`);
      console.log(`Path:    ${s.filePath}`);
      console.log(`Started: ${formatTimestamp(s.startedMs)}`);
      console.log(`CWD:     ${s.cwd || "-"}`);
      console.log(`Records: ${s.records}`);
      if (s.slug) console.log(`Title:   ${s.slug}`);
      console.log("");

      const fmt = (sid: string, name: string, started: string, msgs: string) =>
        `${sid.padEnd(36)}  ${name.padEnd(30)}  ${started.padEnd(17)}  ${msgs}`;
      console.log(fmt("Session ID", "Name", "Started", "Messages"));
      console.log(fmt("----------", "----", "-------", "--------"));

      const { started, slug } = parseSessionMeta(s.filePath);
      console.log(fmt(s.sessionId, slug || "-", started, String(s.records)));

      if (opts.verbose) {
        const messages = extractUserMessages(s.filePath, 5);
        for (const msg of messages) {
          const lines = msg.split("\n");
          for (const line of lines.slice(0, 3)) {
            console.log(`  > ${line.slice(0, 120)}`);
          }
          if (lines.length > 3) {
            console.log(`  > ... (${lines.length - 3} more lines)`);
          }
        }
      }
    }));

  // --- search ---
  session
    .command("search")
    .description("Search conversation history across all projects")
    .argument("<query>", "Text to search for")
    .option("-p, --project <project>", "Filter to sessions whose cwd contains this path")
    .option("-n, --limit <n>", "Max number of matching files to show", "20")
    .option("-i, --ignore-case", "Case-insensitive search")
    .action(safeAction((query: string, opts: { project?: string; limit: string; ignoreCase?: boolean }) => {
      logger.debug(`session search: query="${query}" project=${opts.project || "(all)"} limit=${opts.limit} ignoreCase=${!!opts.ignoreCase}`);
      const limit = parseInt(opts.limit, 10);
      let sessions = discoverSessions(SESSIONS_DIR);

      if (opts.project) {
        const projectQ = opts.project.toLowerCase();
        sessions = sessions.filter((s) => s.cwd.toLowerCase().includes(projectQ));
      }

      let count = 0;

      for (const s of sessions) {
        if (count >= limit) break;
        let found = false;

        try {
          const content = fs.readFileSync(s.filePath, "utf-8");
          const lines = content.split("\n");

          for (let lineno = 0; lineno < lines.length; lineno++) {
            const line = lines[lineno];
            if (!line.trim()) continue;

            const match = opts.ignoreCase
              ? line.toLowerCase().includes(query.toLowerCase())
              : line.includes(query);

            if (match) {
              if (!found) {
                console.log(`[${formatTimestamp(s.startedMs)}  →  ${s.sessionId}]  ${s.cwd || ""}`);
                found = true;
                count++;
              }

              try {
                const d = JSON.parse(line);
                const { role, text } = extractText(d);
                if (text) {
                  console.log(`  line ${lineno + 1} [${role}]: ${snippet(text, query)}`);
                } else {
                  console.log(`  line ${lineno + 1}: ${line.slice(0, 140)}`);
                }
              } catch {
                console.log(`  line ${lineno + 1}: ${line.slice(0, 140)}`);
              }

              const matchCount = lines.slice(0, lineno + 1).filter((l, i) => {
                if (i > lineno) return false;
                return opts.ignoreCase
                  ? l.toLowerCase().includes(query.toLowerCase())
                  : l.includes(query);
              }).length;
              if (matchCount >= 5) break;
            }
          }
          if (found) console.log("");
        } catch {
          // skip unreadable files
        }
      }
    }));

  // --- ps ---
  session
    .command("ps")
    .description("Show active Codex CLI processes")
    .action(safeAction(() => {
      logger.debug("session ps: active process state is no longer stored as session .json files");
      console.log("Active process state is no longer stored as ~/.codex/sessions/*.json.");
      console.log("Use `codx session list` to see recent sessions.");
    }));

  // --- stats ---
  session
    .command("stats")
    .description("Show summary statistics across all Codex CLI sessions")
    .action(safeAction(() => {
      logger.debug(`session stats: scanning ${SESSIONS_DIR}`);
      const sessions = discoverSessions(SESSIONS_DIR);
      const nSessions = sessions.length;
      const totalRecords = sessions.reduce((sum, s) => sum + s.records, 0);

      console.log(`Sessions:        ${nSessions}`);
      console.log(`Total records:   ${totalRecords}`);
      console.log("");

      const totalSize = formatSize(getDirSize(CODEX_DIR));
      const sessionsSize = formatSize(getDirSize(SESSIONS_DIR));
      console.log("Storage:");
      console.log(`  Total:         ${totalSize}`);
      console.log(`  Sessions:      ${sessionsSize}`);
    }));

  // --- clean ---
  session
    .command("clean")
    .description("Delete session JSONL files older than N days")
    .option("-d, --days <n>", "Delete files older than this many days", "30")
    .option("--dry-run", "Show what would be deleted without deleting")
    .action(safeAction((opts: { days: string; dryRun?: boolean }) => {
      logger.debug(`session clean: days=${opts.days} dryRun=${!!opts.dryRun}`);
      const days = parseInt(opts.days, 10);
      const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
      let deleted = 0;
      let freed = 0;

      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        const dirsToMaybeRemove: string[] = [];
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            dirsToMaybeRemove.push(fullPath);
          } else if (entry.name.endsWith(".jsonl")) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.mtimeMs < cutoffMs) {
                const size = stat.size;
                if (opts.dryRun) {
                  console.log(`[dry-run] would delete: ${fullPath}  (${Math.floor(size / 1024)}KB)`);
                } else {
                  fs.unlinkSync(fullPath);
                  console.log(`Deleted: ${fullPath}`);
                }
                deleted++;
                freed += size;
              }
            } catch {
              // skip
            }
          }
        }

        // Remove empty date directories after deletion, but only if not dry-run
        if (!opts.dryRun) {
          for (const dir of dirsToMaybeRemove) {
            try {
              const remaining = fs.readdirSync(dir);
              if (remaining.length === 0) {
                fs.rmdirSync(dir);
              }
            } catch {
              // ignore
            }
          }
        }
      };

      walk(SESSIONS_DIR);

      console.log("");
      const verb = opts.dryRun ? "Would delete" : "Deleted";
      console.log(`${verb} ${deleted} file(s) (~${Math.floor(freed / 1024)}KB freed)`);
    }));

  // --- troubleshoot ---
  session
    .command("troubleshoot")
    .description("Launch Codex CLI to troubleshoot a session file")
    .argument("<session>", "Session ID or partial match")
    .option("-i, --interactive", "Open an interactive Codex CLI window instead of a one-shot prompt")
    .action(safeAction((sessionId: string, opts: { interactive?: boolean }) => {
      logger.debug(`session troubleshoot: session=${sessionId} interactive=${!!opts.interactive}`);
      console.log(`Searching for session '${sessionId}'...`);
      const match = findSessionByQuery(sessionId);
      if (!fs.existsSync(match.filePath)) {
        throw new Error(`Session file no longer exists: ${match.filePath}`);
      }
      console.log(`Found session file: ${match.filePath}`);

      const nodeBinary = process.argv[0];
      const scriptPath = process.argv[1];

      let args: string[];
      const promptText = `Please analyze this Codex CLI session file: ${match.filePath}\n\nThe file contains a JSONL conversation history. Review it for any errors, anomalies, or issues (truncated responses, failed tool calls, error messages, corrupted data, etc.). Summarize what happened in the session and identify any problems that need attention. If the file is very large, focus on the most recent turns and any lines containing "error", "exception", "failed", or non-JSON content.`;
      if (opts.interactive) {
        console.log("Launching Codex CLI (interactive)...");
        logger.info(`session troubleshoot: launching codx run (interactive) for ${match.filePath}`);
        args = ["run", promptText];
      } else {
        console.log("Launching Codex CLI with prompt...");
        logger.info(`session troubleshoot: launching codx run -p "${promptText}"`);
        args = ["run", "-p", promptText];
      }

      const result = spawnSync(nodeBinary, [scriptPath, ...args], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });

      process.exit(result.status ?? 1);
    }));

  return session;
}
