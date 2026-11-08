// Share worker: lends RAM to factions (boosts reputation gain from faction work).
// args: rounds (each ns.share() takes ~10s), tag
import type { NS } from "@ns";
export async function main(ns: NS): Promise<void> {
  const rounds = Math.max(1, Number(ns.args[0]) || 1);
  for (let i = 0; i < rounds; i++) await ns.share();
}
