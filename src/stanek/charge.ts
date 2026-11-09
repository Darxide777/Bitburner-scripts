// Stanek charger: charges each given fragment `rounds` times with this script's threads.
// args: rounds (0 = forever), JSON [[x, y], ...]
// A fragment's highestCharge is the most threads used in ONE call (cores don't count), so
// this runs as a single big process on the biggest block. Each call takes 1 s.
import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // rounds ≤ 0: charge forever (continuous mode; the daemon kills us to move or stop)
  const rounds = Number(ns.args[0]) || 0;
  const roots = JSON.parse(String(ns.args[1] ?? "[]")) as [number, number][];
  for (let r = 0; rounds <= 0 || r < rounds; r++) for (const [x, y] of roots) await ns.stanek.chargeFragment(x, y);
}
