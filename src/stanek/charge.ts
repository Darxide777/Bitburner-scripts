// Stanek charger: charges each given fragment `rounds` times with this script's threads.
// args: rounds, JSON [[x, y], ...]
// A fragment's highestCharge is the most threads (× core bonus) used in ONE call, so this
// runs as a single big process (on home for the core bonus). Each call takes 1 s.
import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const rounds = Math.max(1, Number(ns.args[0]) || 1);
  const roots = JSON.parse(String(ns.args[1] ?? "[]")) as [number, number][];
  for (let r = 0; r < rounds; r++) for (const [x, y] of roots) await ns.stanek.chargeFragment(x, y);
}
