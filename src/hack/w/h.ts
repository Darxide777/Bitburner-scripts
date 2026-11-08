// Hack worker. args: target, additionalMsec, tag (tag only keeps args unique per batch)
import type { NS } from "@ns";
export async function main(ns: NS): Promise<void> {
  await ns.hack(String(ns.args[0]), { additionalMsec: Number(ns.args[1]) || 0 });
}
