import net from "node:net";
import http from "node:http";
import * as logger from "../logger.js";

export interface ProxyServer {
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
}

export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

const PORT_RANGE_MIN = 57000;
const PORT_RANGE_MAX = 57999;

async function isPortAvailable(port: number, listenAddress: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, listenAddress);
  });
}

export async function findAvailablePort(listenAddress: string): Promise<number> {
  const candidate = Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1)) + PORT_RANGE_MIN;
  if (await isPortAvailable(candidate, listenAddress)) {
    return candidate;
  }
  // Linear scan from the next port, wrapping around at the range boundary.
  for (let offset = 1; offset <= PORT_RANGE_MAX - PORT_RANGE_MIN; offset++) {
    const port = PORT_RANGE_MIN + ((candidate - PORT_RANGE_MIN + offset) % (PORT_RANGE_MAX - PORT_RANGE_MIN + 1));
    if (await isPortAvailable(port, listenAddress)) {
      return port;
    }
  }
  throw new Error(`No available port in range ${PORT_RANGE_MIN}-${PORT_RANGE_MAX}`);
}

export async function startProxyServer(
  port: number,
  listenAddress: string,
  requestHandler: RequestHandler,
): Promise<ProxyServer> {
  const actualPort = port === 0 ? await findAvailablePort(listenAddress) : port;

  const server = http.createServer(async (req, res) => {
    logger.debug(`Proxy request: ${req.method} ${req.url}`);
    try {
      await requestHandler(req, res);
    } catch (err) {
      logger.error("Proxy request handler error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "internal_error", message: String(err) } }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(actualPort, listenAddress, () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("Failed to determine server address"));
        return;
      }
      const boundPort = addr.port;
      const baseUrl = `http://${listenAddress}:${boundPort}`;
      logger.debug(`Proxy server listening on ${baseUrl}`);
      resolve({
        baseUrl,
        port: boundPort,
        stop: () =>
          new Promise((resolveStop) => {
            logger.debug("Proxy server stopping");
            server.close((err) => {
              if (err) logger.error("Error stopping proxy server", err);
              resolveStop();
            });
          }),
      });
    });
    server.on("error", reject);
  });
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function parseJsonBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error("invalid JSON");
  }
}

export function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function sendError(
  res: http.ServerResponse,
  statusCode: number,
  message: string,
  type = "api_error",
): void {
  sendJson(res, statusCode, { error: { type, message } });
}
