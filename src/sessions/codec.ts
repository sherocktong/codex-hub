import { createPathCodec } from "../platform/index.js";
import * as logger from "../logger.js";

export function encodePath(p: string): string {
  const encoded = createPathCodec().encode(p);
  logger.debug(`codec: encode "${p}" -> "${encoded}"`);
  return encoded;
}

export function decodePath(encoded: string): string {
  const decoded = createPathCodec().decode(encoded);
  logger.debug(`codec: decode "${encoded}" -> "${decoded}"`);
  return decoded;
}
