export interface IBinaryResolver {
  resolve(pinnedVersion?: string): string;
}

export interface IPathCodec {
  encode(p: string): string;
  decode(encoded: string): string;
}
