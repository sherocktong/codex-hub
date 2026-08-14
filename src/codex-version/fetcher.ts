let cache: Array<{ version: string; date: string }> | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

declare const __PKG_VERSION__: string;

interface NpmPackageData {
  time?: Record<string, string>;
  versions?: Record<string, unknown>;
}

function sortSemverDesc(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10));
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const an = av[i] || 0;
    const bn = bv[i] || 0;
    if (an !== bn) return bn - an;
  }
  return 0;
}

export async function fetchNpmVersions(): Promise<Array<{ version: string; date: string }>> {
  if (cache && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cache;
  }

  const url = "https://registry.npmjs.org/@openai/codex";
  const response = await fetch(url, {
    headers: {
      "User-Agent": `codx/${__PKG_VERSION__ || "0.0.0"}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch npm versions: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as NpmPackageData;
  const platformSuffix = /-(linux|darwin|win32|arm64|x64)(-\w+)?$/;
  const versions = Object.keys(data.versions || {})
    .filter((v) => /^\d+\.\d+\.\d+/.test(v) && !platformSuffix.test(v))
    .map((version) => ({
      version,
      date: data.time?.[version] ? new Date(data.time[version]).toISOString().slice(0, 10) : "",
    }))
    .sort((a, b) => sortSemverDesc(a.version, b.version));

  cache = versions;
  cacheTime = Date.now();
  return versions;
}
