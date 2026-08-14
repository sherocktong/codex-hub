import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireProfileProxy } from "../../src/proxy/instance-manager.js";

const profileName = process.argv[2];
const markerFile = process.argv[3];
if (!profileName || !markerFile) {
  console.error("Usage: fixture <profileName> <markerFile>");
  process.exit(1);
}

const tmpDir = process.env.CODEX_DIR;
if (!tmpDir) {
  console.error("CODEX_DIR not set");
  process.exit(1);
}

const acquired = await acquireProfileProxy(profileName);
console.log(`PID=${process.pid} PORT=${acquired.running.server.port}`);
fs.writeFileSync(markerFile, `${process.pid}\n`, { flag: "a" });

// Wait for a line on stdin before releasing.
process.stdin.setEncoding("utf-8");
process.stdin.once("data", async () => {
  acquired.release();
  // Give the async stop a moment before exiting.
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
});
