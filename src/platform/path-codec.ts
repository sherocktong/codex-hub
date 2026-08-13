import type { IPathCodec } from "./interfaces.js";

export class UnixPathCodec implements IPathCodec {
  encode(p: string): string {
    return p.replace(/[\\/]/g, "-").replace(/\./g, "-").replace(/:/g, "");
  }

  decode(encoded: string): string {
    return encoded.replace(/--/g, "/.").replace(/-/g, "/");
  }
}

export class WindowsPathCodec implements IPathCodec {
  encode(p: string): string {
    return p.replace(/[\\/]/g, "-").replace(/\./g, "-").replace(/:/g, "");
  }

  decode(encoded: string): string {
    const decoded = encoded.replace(/--/g, "\\.").replace(/-/g, "\\");
    if (/^[A-Za-z]\\/.test(decoded)) {
      return decoded[0] + ":" + decoded.slice(1);
    }
    return decoded;
  }
}
