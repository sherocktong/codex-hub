import { describe, it, expect } from "vitest";
import { buildCodexCommand } from "../src/profiles/runner.js";

describe("runner", () => {
  it("builds CLI command with --profile", () => {
    const command = buildCodexCommand({
      binary: "codex",
      profileName: "kimi-dev",
      extraArgs: ["--approval-mode", "full-auto"],
      isDesktopApp: false,
    });
    expect(command).toEqual([
      "codex",
      "--profile",
      "kimi-dev",
      "--approval-mode",
      "full-auto",
    ]);
  });

  it("builds desktop app command without --profile", () => {
    const command = buildCodexCommand({
      binary: "codex",
      profileName: "kimi-dev",
      extraArgs: ["app", "--download-url", "https://example.test"],
      isDesktopApp: true,
    });
    expect(command).toEqual(["codex", "app", "--download-url", "https://example.test"]);
  });
});
