// Bitburner single-player helper: adds this module to the in-game daemon config.
import type { NS } from "@ns";
import { readJson, writeJson } from "../../lib/io.js";
import { DATA } from "../../lib/paths.js";

const MANAGER = "user/dnet/manager.js";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const config = readJson<Record<string, unknown>>(ns, DATA.config, {});
  const modules: unknown[] = Array.isArray(config.userModules) ? [...config.userModules] : [];
  const exists = modules.some(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as { script?: unknown }).script === MANAGER,
  );
  if (!exists) modules.push({ script: MANAGER, args: [], minHomeGB: 0 });
  writeJson(ns, DATA.config, { ...config, userModules: modules });
  ns.tprint(exists ? "Darknet module is already enabled." : "Darknet module enabled in " + DATA.config + ".");
}
