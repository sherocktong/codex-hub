import { SystemBinaryResolver } from "./binary-resolver.js";
import { UnixPathCodec, WindowsPathCodec } from "./path-codec.js";
import type { IBinaryResolver, IPathCodec } from "./interfaces.js";

export function createBinaryResolver(): IBinaryResolver {
  return new SystemBinaryResolver();
}

export function createPathCodec(): IPathCodec {
  if (process.platform === "win32") return new WindowsPathCodec();
  return new UnixPathCodec();
}

export { getCodexVersion } from "./binary-resolver.js";
export type { IBinaryResolver, IPathCodec };
