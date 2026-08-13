import { Command } from "commander";
import {
  SETTINGS_FILE,
  ensureSettingsFile,
  readJson,
  writeJson,
} from "../config.js";
import type { SettingsData, FlatHook, HookEntry } from "../types.js";
import { safeAction } from "../logger.js";
import * as logger from "../logger.js";

function buildFlat(data: SettingsData): FlatHook[] {
  const rows: FlatHook[] = [];
  const hooksRoot = data.hooks || {};
  for (const [event, groups] of Object.entries(hooksRoot)) {
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      for (let hi = 0; hi < g.hooks.length; hi++) {
        const h = g.hooks[hi];
        rows.push({
          seq: h._seq || 0,
          active: true,
          event,
          matcher: g.matcher || "",
          command: h.command,
          gi,
          hi,
          di: -1,
        });
      }
    }
  }
  const pool = data._codex_hub_disabled || [];
  for (let di = 0; di < pool.length; di++) {
    const e = pool[di];
    rows.push({
      seq: e._seq || 0,
      active: false,
      event: e.event || "?",
      matcher: e.matcher || "",
      command: e.command,
      gi: -1,
      hi: -1,
      di,
    });
  }
  rows.sort((a, b) => a.seq - b.seq);
  return rows;
}

function displayHookList(data: SettingsData): void {
  const rows = buildFlat(data);

  if (rows.length === 0) {
    console.log("No hooks defined.");
    return;
  }

  const fmt = (idx: number, active: string, event: string, matcher: string, cmd: string) =>
    `${String(idx).padEnd(4)}  ${active.padEnd(2)}  ${event.padEnd(22)}  ${matcher.padEnd(25)}  ${cmd}`;

  console.log(fmt(0, "", "EVENT", "MATCHER", "COMMAND").replace(/^IDX/, "IDX").replace(/^0/, "IDX"));
  console.log(fmt(0, "", "-----", "-------", "-------").replace(/^0/, "---"));
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const marker = r.active ? " " : "x";
    const matcher = r.matcher || "(any)";
    const cmd = r.command.length > 60 ? r.command.slice(0, 60) + "…" : r.command;
    console.log(fmt(idx, marker, r.event, matcher, cmd));
  }
}

export function hooksCommand(): Command {
  const hooks = new Command("hook")
    .description("Manage Codex CLI hooks in settings.json");

  // --- list ---
  hooks
    .command("list")
    .description("List all hooks")
    .action(safeAction(() => {
      logger.debug("hook list: reading settings");
      ensureSettingsFile();
      const data = readJson<SettingsData>(SETTINGS_FILE);
      logger.debug(`hook list: found ${Object.keys(data.hooks || {}).length} event types`);
      displayHookList(data);
    }));

  // --- add ---
  hooks
    .command("add")
    .description("Add a hook to settings.json")
    .requiredOption("-e, --event <event>", "Hook event (PreToolUse|PostToolUse|Notification|Stop|UserPromptSubmit|PermissionRequest)")
    .option("-m, --matcher <matcher>", "Tool name matcher (omit for catch-all)")
    .requiredOption("-c, --command <command>", "Shell command to run")
    .option("-a, --async", "Run the hook asynchronously")
    .action(safeAction((opts: { event: string; matcher?: string; command: string; async?: boolean }) => {
      logger.debug(`hook add: event=${opts.event} matcher=${opts.matcher || "(any)"}`);
      ensureSettingsFile();
      const data = readJson<SettingsData>(SETTINGS_FILE);
      const hooksRoot = data.hooks || (data.hooks = {});
      const groups = hooksRoot[opts.event] || (hooksRoot[opts.event] = []);

      const matcher = opts.matcher || "";
      let targetGroup = groups.find((g) => (g.matcher || "") === matcher);
      if (!targetGroup) {
        targetGroup = { hooks: [] };
        if (matcher) targetGroup.matcher = matcher;
        groups.push(targetGroup);
      }

      const seq = (data._codex_hub_seq || 0) + 1;
      data._codex_hub_seq = seq;

      const newHook: HookEntry = { type: "command", command: opts.command, _seq: seq };
      if (opts.async) newHook.async = true;

      targetGroup.hooks.push(newHook);
      writeJson(SETTINGS_FILE, data);
      logger.debug(`hook add: wrote settings with new hook seq=${seq}`);
      console.log(`Hook added to event '${opts.event}'${matcher ? ` matcher='${matcher}'` : ""}.`);
    }));

  // --- remove ---
  hooks
    .command("remove")
    .description("Remove a hook by its global index (see 'hooks list')")
    .requiredOption("-i, --index <index>", "Global index from 'hooks list'", parseInt)
    .action(safeAction((opts: { index: number }) => {
      logger.debug(`hook remove: index=${opts.index}`);
      ensureSettingsFile();
      const data = readJson<SettingsData>(SETTINGS_FILE);
      const rows = buildFlat(data);
      const target = opts.index;

      if (target < 0 || target >= rows.length) {
        throw new Error(`Index ${target} out of range (0-${rows.length - 1}).`);
      }

      const r = rows[target];
      if (r.active) {
        const hooksRoot = data.hooks!;
        hooksRoot[r.event][r.gi].hooks.splice(r.hi, 1);
        hooksRoot[r.event] = hooksRoot[r.event].filter((g) => g.hooks.length > 0);
        if (hooksRoot[r.event].length === 0) delete hooksRoot[r.event];
      } else {
        const pool = data._codex_hub_disabled!;
        pool.splice(r.di, 1);
        if (pool.length === 0) delete data._codex_hub_disabled;
      }

      writeJson(SETTINGS_FILE, data);
      logger.debug(`hook remove: wrote settings after removing hook ${target}`);
      console.log(`Hook ${target} removed.`);
    }));

  // --- enable ---
  hooks
    .command("enable")
    .description("Enable one or more disabled hooks")
    .requiredOption("-i, --index <indexes...>", "Global index from 'hooks list' (repeatable)", (v: string, prev: number[]) => {
      prev = prev || [];
      prev.push(parseInt(v));
      return prev;
    })
    .action(safeAction((opts: { index: number[] }) => {
      logger.debug(`hook enable: indexes=[${opts.index.join(", ")}]`);
      ensureSettingsFile();
      const data = readJson<SettingsData>(SETTINGS_FILE);
      const rows = buildFlat(data);
      const targets = [...new Set(opts.index)].sort((a, b) => a - b);

      const errors: string[] = [];
      for (const t of targets) {
        if (t < 0 || t >= rows.length) errors.push(`Index ${t} out of range (0-${rows.length - 1}).`);
        else if (rows[t].active) errors.push(`Index ${t} is already active.`);
      }
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }

      const hooksRoot = data.hooks || (data.hooks = {});
      const pool = data._codex_hub_disabled!;
      const diToTarget = new Map(targets.map((t) => [rows[t].di, t]));

      const remaining: HookEntry[] = [];
      const toRestore: Array<{ entry: HookEntry; t: number }> = [];
      for (let di = 0; di < pool.length; di++) {
        const t = diToTarget.get(di);
        if (t !== undefined) {
          toRestore.push({ entry: pool[di], t });
        } else {
          remaining.push(pool[di]);
        }
      }

      for (const { entry, t } of toRestore) {
        const event = entry.event!;
        const matcher = entry.matcher || "";
        const hook = { type: entry.type, command: entry.command, _seq: entry._seq, ...(entry.async ? { async: true } : {}) };
        const groups = hooksRoot[event] || (hooksRoot[event] = []);
        let grp = groups.find((g) => (g.matcher || "") === matcher);
        if (!grp) {
          grp = { hooks: [] };
          if (matcher) grp.matcher = matcher;
          groups.push(grp);
        }
        grp.hooks.push(hook);
        console.log(`Hook ${t} (${event}) enabled.`);
      }

      data._codex_hub_disabled = remaining;
      if (remaining.length === 0) delete data._codex_hub_disabled;
      writeJson(SETTINGS_FILE, data);
      logger.debug(`hook enable: wrote settings after restoring ${toRestore.length} hook(s)`);
      console.log("");
      displayHookList(data);
    }));

  // --- disable ---
  hooks
    .command("disable")
    .description("Disable one or more hooks (removes from active)")
    .requiredOption("-i, --index <indexes...>", "Global index from 'hooks list' (repeatable)", (v: string, prev: number[]) => {
      prev = prev || [];
      prev.push(parseInt(v));
      return prev;
    })
    .action(safeAction((opts: { index: number[] }) => {
      logger.debug(`hook disable: indexes=[${opts.index.join(", ")}]`);
      ensureSettingsFile();
      const data = readJson<SettingsData>(SETTINGS_FILE);
      const rows = buildFlat(data);
      const targets = [...new Set(opts.index)].sort((a, b) => a - b);

      const errors: string[] = [];
      for (const t of targets) {
        if (t < 0 || t >= rows.length) errors.push(`Index ${t} out of range (0-${rows.length - 1}).`);
        else if (!rows[t].active) errors.push(`Index ${t} is already disabled.`);
      }
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }

      const hooksRoot = data.hooks!;
      const pool = data._codex_hub_disabled || (data._codex_hub_disabled = []);

      for (const t of [...targets].reverse()) {
        const r = rows[t];
        const hook = hooksRoot[r.event][r.gi].hooks[r.hi];
        const entry: HookEntry = {
          event: r.event,
          ...hook,
        };
        if (r.matcher) entry.matcher = r.matcher;
        pool.push(entry);

        hooksRoot[r.event][r.gi].hooks.splice(r.hi, 1);
        hooksRoot[r.event] = hooksRoot[r.event].filter((g) => g.hooks.length > 0);
        if (hooksRoot[r.event].length === 0) delete hooksRoot[r.event];
        console.log(`Hook ${t} (${r.event}) disabled.`);
      }

      writeJson(SETTINGS_FILE, data);
      logger.debug(`hook disable: wrote settings after disabling ${targets.length} hook(s)`);
      console.log("");
      displayHookList(data);
    }));

  return hooks;
}
