import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";

const TEST_DIR = path.join(os.tmpdir(), `codx-sessions-commands-test-${process.pid}`);
process.env.CODEX_DIR = TEST_DIR;

import {
  discoverSessions,
  findSessionByQuery,
  extractUserMessages,
  parseSessionMeta,
  extractText,
} from "../src/sessions/utils.js";

const TEST_SESSIONS_DIR = path.join(TEST_DIR, "sessions");

function writeSampleSession(opts: {
  dateDir?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  userMessages?: string[];
  title?: string;
}): { filePath: string; uuid: string } {
  const uuid = opts.uuid || "01a0138a-f66e-7ac0-9539-0675b90bbe4d";
  const dateDir = opts.dateDir || "2026/08/18";
  const timestamp = opts.timestamp || "2026-08-18T14:24:29.000Z";
  const cwd = opts.cwd || "/Users/kangtong/project";
  const userMessages = opts.userMessages || ["hello world"];

  const dir = path.join(TEST_SESSIONS_DIR, dateDir);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = `rollout-${timestamp.replace(/[:.]/g, "-").replace("Z", "")}-${uuid}.jsonl`;
  const filePath = path.join(dir, fileName);

  const lines: string[] = [];

  // Modern Codex CLI session_meta record
  lines.push(JSON.stringify({
    timestamp,
    ordinal: 0,
    type: "session_meta",
    payload: {
      session_id: uuid,
      cwd,
      timestamp,
      originator: "codex",
      cli_version: "1.0.0",
    },
  }));

  if (opts.title) {
    lines.push(JSON.stringify({
      timestamp,
      ordinal: 1,
      type: "title",
      title: opts.title,
    }));
  }

  let ordinal = opts.title ? 2 : 1;
  for (const msg of userMessages) {
    lines.push(JSON.stringify({
      timestamp,
      ordinal: ordinal++,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: msg }],
    }));
  }

  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return { filePath, uuid };
}

function runCodx(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/index.js"), ...args], {
    env: { ...process.env, CODEX_DIR: TEST_DIR },
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

describe("session utils", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("discovers sessions in date-organized directories", () => {
    writeSampleSession({ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cwd: "/tmp/a" });
    writeSampleSession({ uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", cwd: "/tmp/b", dateDir: "2025/12/31" });

    const sessions = discoverSessions(TEST_SESSIONS_DIR);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ]);
  });

  it("extracts cwd and record count from session files", () => {
    writeSampleSession({ uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc", cwd: "/tmp/c", userMessages: ["one", "two"] });

    const sessions = discoverSessions(TEST_SESSIONS_DIR);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe("/tmp/c");
    expect(sessions[0].records).toBe(3); // meta + 2 messages
  });

  it("finds a session by partial uuid", () => {
    writeSampleSession({ uuid: "11111111-1111-1111-1111-111111111111" });
    writeSampleSession({ uuid: "22222222-2222-2222-2222-222222222222" });

    const sessions = discoverSessions(TEST_SESSIONS_DIR);
    const found = findSessionByQuery("1111", sessions);
    expect(found.sessionId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("throws when session query matches multiple", () => {
    writeSampleSession({ uuid: "aaaaaaaa-1111-1111-1111-111111111111" });
    writeSampleSession({ uuid: "aaaaaaaa-2222-2222-2222-222222222222" });

    const sessions = discoverSessions(TEST_SESSIONS_DIR);
    expect(() => findSessionByQuery("aaaaaaaa", sessions)).toThrow("Multiple sessions matched");
  });

  it("extracts user messages", () => {
    const { filePath } = writeSampleSession({
      uuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      userMessages: ["first message", "second message"],
    });

    const messages = extractUserMessages(filePath);
    expect(messages).toEqual(["first message", "second message"]);
  });

  it("extracts text from codex cli message parts", () => {
    const result = extractText({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
    expect(result).toEqual({ role: "user", text: "hello" });
  });

  it("extracts text from legacy message shape", () => {
    const result = extractText({
      type: "user",
      message: { role: "user", content: "legacy" },
    });
    expect(result).toEqual({ role: "user", text: "legacy" });
  });

  it("parses session meta including title", () => {
    const { filePath } = writeSampleSession({
      uuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      title: "My Session",
    });

    const meta = parseSessionMeta(filePath);
    expect(meta.slug).toBe("My Session");
    expect(meta.started).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("session commands (integration)", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("lists sessions", () => {
    writeSampleSession({ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cwd: "/tmp/a" });
    writeSampleSession({ uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", cwd: "/tmp/b" });

    const { stdout } = runCodx(["session", "list"]);
    expect(stdout).toContain("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(stdout).toContain("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  });

  it("lists sessions as json", () => {
    writeSampleSession({ uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc", cwd: "/tmp/c" });

    const { stdout } = runCodx(["session", "list", "--json"]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.sessionId).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(parsed.cwd).toBe("/tmp/c");
  });

  it("shows a session by partial uuid", () => {
    writeSampleSession({ uuid: "dddddddd-dddd-dddd-dddd-dddddddddddd", cwd: "/tmp/d" });

    const { stdout } = runCodx(["session", "show", "dddd"]);
    expect(stdout).toContain("dddddddd-dddd-dddd-dddd-dddddddddddd");
    expect(stdout).toContain("/tmp/d");
  });

  it("searches across sessions", () => {
    writeSampleSession({ uuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", userMessages: ["find me"] });
    writeSampleSession({ uuid: "ffffffff-ffff-ffff-ffff-ffffffffffff", userMessages: ["not here"] });

    const { stdout } = runCodx(["session", "search", "find me"]);
    expect(stdout).toContain("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    expect(stdout).not.toContain("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });

  it("stats reports sessions and records", () => {
    writeSampleSession({ uuid: "11111111-1111-1111-1111-111111111111", userMessages: ["a", "b"] });

    const { stdout } = runCodx(["session", "stats"]);
    expect(stdout).toContain("Sessions:        1");
    expect(stdout).toContain("Total records:   3");
  });

  it("clean dry-run does not delete", () => {
    const { filePath } = writeSampleSession({ uuid: "22222222-2222-2222-2222-222222222222" });

    const { stdout } = runCodx(["session", "clean", "--days", "0", "--dry-run"]);
    expect(stdout).toContain("[dry-run]");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("ps prints no-op message", () => {
    const { stdout } = runCodx(["session", "ps"]);
    expect(stdout).toContain("Active process state is no longer stored");
  });
});
