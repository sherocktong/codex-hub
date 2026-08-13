import { Command } from "commander";
import { safeAction } from "../logger.js";
import { fetchNpmVersions } from "./fetcher.js";
import { getPinnedVersion, setPinnedVersion } from "./utils.js";
import { getCodexVersion } from "../platform/index.js";

export function codexVersionCommand(): Command {
  const cmd = new Command("codex-version")
    .description("Manage Codex CLI versions");

  cmd
    .command("list")
    .description("List available Codex CLI versions")
    .action(safeAction(async () => {
      const [remoteVersions, installedVersion, pinnedVersion] = await Promise.all([
        fetchNpmVersions().catch(() => [] as Array<{ version: string; date: string }>),
        Promise.resolve(getCodexVersion()).catch(() => "unknown"),
        Promise.resolve(getPinnedVersion()),
      ]);

      if (remoteVersions.length === 0) {
        console.log("Could not fetch remote versions. Showing installed version only.");
        console.log(`Installed: ${installedVersion}`);
        if (pinnedVersion) {
          console.log(`Pinned:    ${pinnedVersion}`);
        }
        return;
      }

      console.log("Available Codex CLI versions:");
      console.log("");
      const maxVersionLen = Math.max(...remoteVersions.map(v => v.version.length), 10);
      const maxDateLen = Math.max(...remoteVersions.map(v => v.date.length), 4);

      console.log(`${"Version".padEnd(maxVersionLen)}  ${"Date".padEnd(maxDateLen)}  Status`);
      console.log("-".repeat(maxVersionLen + maxDateLen + 10));

      for (const { version, date } of remoteVersions.slice(0, 20)) {
        const markers: string[] = [];
        if (version === installedVersion) markers.push("installed");
        if (version === pinnedVersion) markers.push("pinned");
        const status = markers.length > 0 ? `(${markers.join(", ")})` : "";
        console.log(`${version.padEnd(maxVersionLen)}  ${(date || "—").padEnd(maxDateLen)}  ${status}`);
      }

      if (remoteVersions.length > 20) {
        console.log(`... and ${remoteVersions.length - 20} more versions`);
      }

      console.log("");
      console.log(`Installed: ${installedVersion}`);
      if (pinnedVersion) {
        console.log(`Pinned:    ${pinnedVersion}`);
      } else {
        console.log("No version pinned (using latest)");
      }
    }));

  cmd
    .command("unpin")
    .description("Remove the Codex CLI version pin")
    .action(safeAction(() => {
      setPinnedVersion(undefined);
      console.log("Version pin cleared. codex-hub will use the latest available Codex CLI version.");
    }));

  cmd
    .command("pin [version]")
    .description("Pin Codex CLI to a specific version")
    .option("--clear", "Remove the version pin")
    .action(safeAction(async (version: string | undefined, opts: { clear?: boolean }) => {
      if (opts.clear || !version) {
        setPinnedVersion(undefined);
        console.log("Version pin cleared. codex-hub will use the latest available Codex CLI version.");
        return;
      }

      // Validate semver-ish format
      if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)) {
        console.error(`Invalid version format: ${version}. Expected format: x.y.z or x.y.z-prerelease`);
        process.exit(1);
      }

      setPinnedVersion(version);
      console.log(`Pinned Codex CLI version: ${version}`);
      console.log(`Ensure the global install matches the pinned version:`);
      console.log(`  npm install -g @openai/codex@${version}`);
    }));

  return cmd;
}
