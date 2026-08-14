import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as logger from "../logger.js";

function resolveCliPath(): string {
  // Use the currently executing script if it is the CLI bundle. This handles
  // both `node dist/index.js` and a globally installed `codx` binary, where
  // `__dirname` inside a single-file bundle resolves incorrectly.
  const invoked = process.argv[1];
  if (invoked) {
    const resolved = path.resolve(invoked);
    const name = path.basename(resolved);
    if ((name === "index.js" || name === "codx" || name === "codx-hub") && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  // Fallback for development/test runs from source: compute from this file's
  // location up to the expected dist output.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..", "dist", "index.js");
}

const CLI_PATH = resolveCliPath();
const PROXY_READY_PREFIX = "PROXY_READY port=";

export interface ProxyDaemonHandle {
  port: number;
  baseUrl: string;
  pid: number;
  kill: () => Promise<void>;
}

export async function startProxyDaemon(profileName: string): Promise<ProxyDaemonHandle> {
  const args = [CLI_PATH, "__proxy-server", profileName];
  logger.debug(`Starting proxy daemon for profile '${profileName}': ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.unref();

    child.stdout!.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString("utf-8");
      if (resolved) return;
      const lines = stdoutBuffer.split("\n");
      for (const line of lines) {
        if (line.startsWith(PROXY_READY_PREFIX)) {
          const port = Number(line.slice(PROXY_READY_PREFIX.length).trim());
          if (!Number.isFinite(port) || port <= 0) {
            reject(new Error(`Proxy daemon reported invalid port: ${line}`));
            child.kill();
            return;
          }
          resolved = true;
          const listenAddress = "127.0.0.1";
          resolve({
            port,
            baseUrl: `http://${listenAddress}:${port}`,
            pid: child.pid!,
            kill: () => stopDaemon(child),
          });
          return;
        }
      }
    });

    child.stderr!.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      stderrBuffer += text;
      const trimmed = text.trim();
      if (trimmed) logger.debug(`Proxy daemon stderr: ${trimmed}`);
    });

    child.on("error", (err) => {
      if (!resolved) reject(err);
    });

    child.on("exit", (code) => {
      if (!resolved) {
        const output = (stderrBuffer || stdoutBuffer).trim();
        const detail = output ? `\nDaemon output:\n${output}` : "";
        reject(new Error(`Proxy daemon exited early with code ${code ?? "unknown"}${detail}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        child.kill();
        const output = (stderrBuffer || stdoutBuffer).trim();
        const detail = output ? `\nDaemon output:\n${output}` : "";
        reject(new Error(`Timeout waiting for proxy daemon to start${detail}`));
      }
    }, 15000);
  });
}

async function stopDaemon(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 5000);

    child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}
