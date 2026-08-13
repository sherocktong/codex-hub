import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECTS_DIR, SESSIONS_DIR, CODEX_DIR } from "../config.js";
import { encodePath, decodePath } from "./codec.js";
import { getDirSize, formatSize } from "./stats.js";
import { formatTimestamp, findProjectDir, parseSessionMeta, extractText, snippet, findSessionFile } from "./utils.js";
import { safeAction } from "../logger.js";
import * as logger from "../logger.js";

export function sessionCommand(): Command {
  const session = new Command("session")
    .description("Manage Codex CLI sessions");

  // --- list ---
  session
    .command("list")
    .description("List all Codex CLI project sessions")
    .option("-n, --limit <n>", "Max number of projects to show", "30")
    .option("-s, --short", "Show encoded names only (no decoding)")
    .option("-j, --json", "Output as JSON lines")
    .action(safeAction((opts: { limit: string; short?: boolean; json?: boolean }) => {
      logger.debug(`session list: reading projects from ${PROJECTS_DIR}, limit=${opts.limit}`);
      const limit = parseInt(opts.limit, 10);
      let dirs: string[];
      try {
        dirs = fs.readdirSync(PROJECTS_DIR);
      } catch {
        console.log("No projects directory found.");
        return;
      }

      dirs.sort((a, b) => {
        const statA = fs.statSync(path.join(PROJECTS_DIR, a));
        const statB = fs.statSync(path.join(PROJECTS_DIR, b));
        return statB.mtimeMs - statA.mtimeMs;
      });

      let count = 0;
      for (const projDir of dirs) {
        if (count >= limit) break;
        const fullPath = path.join(PROJECTS_DIR, projDir);
        let nSessions = 0;
        try {
          nSessions = fs.readdirSync(fullPath).filter((f) => f.endsWith(".jsonl")).length;
        } catch { /* skip */ }

        const stat = fs.statSync(fullPath);
        const decoded = decodePath(projDir);

        if (opts.json) {
          console.log(JSON.stringify({ project: decoded, sessions: nSessions, modified: Math.floor(stat.mtimeMs) }));
        } else if (opts.short) {
          console.log(projDir);
        } else {
          console.log(`${decoded.padEnd(55)}  ${String(nSessions).padStart(3)} session(s)  ${formatTimestamp(stat.mtimeMs)}`);
        }
        count++;
      }
    }));

  // --- show ---
  session
    .command("show")
    .description("Show session files for a project")
    .argument("<project>", "Project path or encoded name (partial match ok)")
    .option("-v, --verbose", "Show first user message of each session")
    .action(safeAction((project: string, opts: { verbose?: boolean }) => {
      logger.debug(`session show: project=${project} verbose=${!!opts.verbose}`);
      const projDir = findProjectDir(project);
      if (!projDir) {
        throw new Error(`No project matched: ${project}`);
      }

      const fullPath = path.join(PROJECTS_DIR, projDir);
      console.log(`Project: ${decodePath(projDir)}`);
      console.log(`Dir:     ${fullPath}`);
      console.log("");

      const fmt = (sid: string, name: string, started: string, msgs: string) =>
        `${sid.padEnd(36)}  ${name.padEnd(30)}  ${started.padEnd(17)}  ${msgs}`;
      console.log(fmt("Session ID", "Name", "Started", "Messages"));
      console.log(fmt("----------", "----", "-------", "--------"));

      let files: string[];
      try {
        files = fs.readdirSync(fullPath).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return;
      }

      for (const file of files) {
        const filePath = path.join(fullPath, file);
        const sessionId = file.replace(/\.jsonl$/, "");
        let msgCount = 0;
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          msgCount = content ? content.split("\n").filter((l) => l.trim()).length : 0;
        } catch { /* skip */ }

        const { started, slug } = parseSessionMeta(filePath);
        console.log(fmt(sessionId, slug || "-", started, String(msgCount)));

        if (opts.verbose) {
          try {
            const lines = fs.readFileSync(filePath, "utf-8").split("\n");
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const d = JSON.parse(line);
                if (d.type === "user") {
                  const content = d.message?.content;
                  if (Array.isArray(content)) {
                    for (const part of content) {
                      if (typeof part === "object" && part?.type === "text") {
                        console.log(`  > ${part.text.slice(0, 120)}`);
                        break;
                      }
                    }
                  } else if (typeof content === "string") {
                    console.log(`  > ${content.slice(0, 120)}`);
                  }
                  break;
                }
              } catch { /* skip bad lines */ }
            }
          } catch { /* skip */ }
        }
      }
    }));

  // --- search ---
  session
    .command("search")
    .description("Search conversation history across all projects")
    .argument("<query>", "Text to search for")
    .option("-p, --project <project>", "Filter to a specific project (partial match)")
    .option("-n, --limit <n>", "Max number of matching files to show", "20")
    .option("-i, --ignore-case", "Case-insensitive search")
    .action(safeAction((query: string, opts: { project?: string; limit: string; ignoreCase?: boolean }) => {
      logger.debug(`session search: query="${query}" project=${opts.project || "(all)"} limit=${opts.limit} ignoreCase=${!!opts.ignoreCase}`);
      const searchRoots: Array<{ root: string; label: string }> = [{ root: PROJECTS_DIR, label: "" }];

      if (opts.project) {
        const projDir = findProjectDir(opts.project);
        if (!projDir) {
          throw new Error(`No project matched: ${opts.project}`);
        }
        searchRoots.length = 0;
        searchRoots.push({ root: path.join(PROJECTS_DIR, projDir), label: "" });
      }

      const limit = parseInt(opts.limit, 10);
      let count = 0;

      function searchDir(dir: string, label: string, baseDir: string): void {
        if (count >= limit) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (count >= limit) break;
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            searchDir(fullPath, label, baseDir);
          } else if (entry.name.endsWith(".jsonl")) {
            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const lines = content.split("\n");
              let found = false;

              for (let lineno = 0; lineno < lines.length; lineno++) {
                const line = lines[lineno];
                if (!line.trim()) continue;

                const match = opts.ignoreCase
                  ? line.toLowerCase().includes(query.toLowerCase())
                  : line.includes(query);

                if (match) {
                  if (!found) {
                    const relPath = path.relative(baseDir, fullPath);
                    const projEnc = relPath.split(path.sep)[0];
                    const sessionId = path.basename(fullPath, ".jsonl");
                    const projName = decodePath(projEnc);
                    console.log(`${label}[${projName}  →  ${sessionId}]`);
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
            } catch { /* skip unreadable files */ }
          }
        }
      }

      for (const { root, label } of searchRoots) {
        searchDir(root, label, root);
      }
    }));

  // --- ps ---
  session
    .command("ps")
    .description("Show active Codex CLI processes")
    .action(safeAction(() => {
      logger.debug(`session ps: reading sessions from ${SESSIONS_DIR}`);
      let files: string[];
      try {
        files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
      } catch {
        console.log("(no session files found)");
        return;
      }

      if (files.length === 0) {
        console.log("(no session files found)");
        return;
      }

      const fmt = (pid: string, sid: string, started: string, cwd: string, status: string) =>
        `${pid.padEnd(8)}  ${sid.padEnd(40)}  ${started.padEnd(20)}  ${cwd}${status}`;
      console.log(fmt("PID", "Session ID", "Started", "CWD", ""));
      console.log(fmt("---", "----------", "-------", "---", ""));

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8"));
          const pid = String(data.pid || "?");
          const sessionId = data.sessionId || "?";
          const cwd = data.cwd || "?";
          const startedMs = data.startedAt || 0;

          let alive = " [dead]";
          try {
            process.kill(Number(pid), 0);
            alive = " [running]";
          } catch { /* dead */ }

          console.log(fmt(pid, sessionId, formatTimestamp(startedMs), cwd, alive));
        } catch { /* skip bad files */ }
      }
    }));

  // --- stats ---
  session
    .command("stats")
    .description("Show summary statistics across all Codex CLI sessions")
    .action(safeAction(() => {
      logger.debug(`session stats: scanning ${PROJECTS_DIR}`);
      let nProjects = 0;
      let nSessions = 0;
      let totalMsgs = 0;
      let nActive = 0;

      const walk = (dir: string): string[] => {
        const results: string[] = [];
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) results.push(...walk(fullPath));
            else if (entry.name.endsWith(".jsonl")) results.push(fullPath);
          }
        } catch { /* skip */ }
        return results;
      };

      try {
        nProjects = fs.readdirSync(PROJECTS_DIR).length;
      } catch { /* no projects dir */ }

      try {
        const sessionFiles = walk(PROJECTS_DIR);
        nSessions = sessionFiles.length;
        for (const f of sessionFiles) {
          try {
            const content = fs.readFileSync(f, "utf-8");
            totalMsgs += content ? content.split("\n").filter((l) => l.trim()).length : 0;
          } catch { /* skip */ }
        }
      } catch { /* no projects dir */ }

      try {
        nActive = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")).length;
      } catch { /* no sessions dir */ }

      console.log(`Projects:        ${nProjects}`);
      console.log(`Sessions:        ${nSessions}`);
      console.log(`Total messages:  ${totalMsgs}`);
      console.log(`Active procs:    ${nActive}  (in ${SESSIONS_DIR})`);
      console.log("");

      const totalSize = formatSize(getDirSize(CODEX_DIR));
      const projSize = formatSize(getDirSize(PROJECTS_DIR));
      console.log("Storage:");
      console.log(`  Total:         ${totalSize}`);
      console.log(`  Projects:      ${projSize}`);
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
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
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
            } catch { /* skip */ }
          }
        }
      };

      walk(PROJECTS_DIR);

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
      const match = findSessionFile(sessionId);
      if (!match) {
        throw new Error(`Session '${sessionId}' not found.`);
      }
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
        logger.info(`session troubleshoot: launching codex-hub run (interactive) for ${match.filePath}`);
        args = ["run", promptText];
      } else {
        console.log("Launching Codex CLI with prompt...");
        logger.info(`session troubleshoot: launching codex-hub run -p "${promptText}"`);
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
