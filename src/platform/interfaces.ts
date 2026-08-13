import type { Profile } from "../types.js";

export interface IBinaryResolver {
  resolve(pinnedVersion?: string): string;
}

export interface IPathCodec {
  encode(p: string): string;
  decode(encoded: string): string;
}

export interface IProfileSyncer {
  isSupported(): boolean;
  sync(name: string, profile: Profile): void;
  remove(name: string, profile: Profile): void;
  setActive(profile: Profile): void;
}
