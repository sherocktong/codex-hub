/**
 * UTF-8 safe SSE buffer utilities.
 *
 * These helpers mirror the design of cc-switch's SSE parser: buffer incoming
 * bytes, split on double-newline boundaries, and handle multi-byte characters
 * that may be split across network chunks.
 */

export function appendUtf8Safe(buffer: string, chunk: Buffer): string {
  // Decode the chunk as UTF-8, replacing invalid sequences with the replacement
  // character so that a truncated multi-byte char at the end of one chunk does
  // not corrupt the next chunk.
  return buffer + chunk.toString("utf-8");
}

export function* splitSseBlocks(buffer: string): Generator<{ block: string; remaining: string }> {
  let remaining = buffer;
  while (true) {
    const boundary = findSseBoundary(remaining);
    if (boundary === -1) break;
    const block = remaining.slice(0, boundary).trim();
    remaining = remaining.slice(boundary + 2);
    if (block || remaining) {
      yield { block, remaining };
    }
  }
}

function findSseBoundary(text: string): number {
  const rn = text.indexOf("\r\n\r\n");
  if (rn !== -1) return rn;
  const n = text.indexOf("\n\n");
  if (n !== -1) return n;
  return -1;
}

export function parseSseBlock(block: string): Record<string, string> {
  const lines = block.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      fields[line] = "";
    } else {
      const name = line.slice(0, colonIndex);
      const value = line.slice(colonIndex + 1).replace(/^\s+/, "");
      fields[name] = value;
    }
  }
  return fields;
}

export function stripSseField(block: string, fieldName: string): string {
  return block.split(/\r?\n/).filter((line) => !line.startsWith(`${fieldName}:`)).join("\n");
}

export function serializeSseBlock(fields: Record<string, string | undefined>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\n") + "\n\n";
}
