// Auth command — interactive API key setup.

import { getOrSetupApiKey, loadConfig, saveConfig } from "../config/config.ts";
import { paint } from "../ui/theme.ts";
import { blank, printSystem, writeLine } from "../ui/render.ts";

export async function runAuthCommand(): Promise<void> {
  const cfg = await loadConfig();
  const key = await getOrSetupApiKey(true, cfg);
  if (key) {
    blank();
    printSystem(`${paint.green("✓")} API key configured.`, "green");
    blank();
  } else {
    await saveConfig(cfg);
    blank();
    writeLine("No API key was saved.");
    blank();
  }
}
