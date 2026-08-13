import { describe, it, expect } from "vitest";
import { appendUtf8Safe, splitSseBlocks, parseSseBlock, serializeSseBlock } from "../src/proxy/sse.js";

describe("SSE utilities", () => {
  it("appends binary chunks as UTF-8 text", () => {
    const buffer = appendUtf8Safe("", Buffer.from("data: hello"));
    expect(buffer).toBe("data: hello");
  });

  it("splits complete SSE blocks on double newlines", () => {
    const input = "data: first\n\ndata: second\n\n";
    const blocks = Array.from(splitSseBlocks(input));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].block).toBe("data: first");
    expect(blocks[1].block).toBe("data: second");
    expect(blocks[1].remaining).toBe("");
  });

  it("leaves partial blocks in the remaining buffer", () => {
    const input = "data: partial";
    const blocks = Array.from(splitSseBlocks(input));
    expect(blocks).toHaveLength(0);
  });

  it("parses SSE block fields", () => {
    const block = "data: {\"id\":\"1\"}\nevent: completion";
    const fields = parseSseBlock(block);
    expect(fields.data).toBe('{\"id\":\"1\"}');
    expect(fields.event).toBe("completion");
  });

  it("serializes SSE blocks", () => {
    const text = serializeSseBlock({ data: "[DONE]" });
    expect(text).toBe("data: [DONE]\n\n");
  });
});
