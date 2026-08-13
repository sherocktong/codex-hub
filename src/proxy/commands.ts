import { Command } from "commander";
import { safeAction } from "../logger.js";
import { ensureProviderPresetsExist } from "../proxy/instance-manager.js";
import { readProvidersConfig } from "../proxy/config.js";

export function providerListCommand(): Command {
  ensureProviderPresetsExist();

  const command = new Command("provider")
    .description("Manage configured providers");

  command
    .command("list")
    .description("List configured providers")
    .action(safeAction(() => {
      const providers = readProvidersConfig();
      const ids = Object.keys(providers);
      if (ids.length === 0) {
        console.log("No providers configured.");
        return;
      }
      console.log("Configured providers:");
      for (const id of ids) {
        const p = providers[id];
        console.log(`  ${id}: ${p.name} (${p.type}) @ ${p.baseUrl}`);
      }
    }));

  return command;
}
