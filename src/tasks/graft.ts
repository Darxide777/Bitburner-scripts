// Runs one graft: travel to New Tokyo, start it, and wait for the game to finish.
// args: [out, aug, focus]
import type { NS } from "@ns";
import { appendJsonl, writeJson } from "../lib/io.js";
import { DATA } from "../lib/paths.js";
import type { GraftState } from "../lib/types.js";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const aug = String(ns.args[1] ?? "");
  const focus = ns.args[2] !== false;
  if (!aug) throw new Error("missing augmentation name");

  const sing = ns.singularity;
  const state = (status: GraftState["status"], extra: Partial<GraftState> = {}) =>
    writeJson(ns, DATA.graftingState, { t: Date.now(), aug, status, ...extra } satisfies GraftState);
  const event = (msg: string, data?: unknown) => appendJsonl(ns, DATA.events, { t: Date.now(), kind: "graft", msg, data }, 3000);

  try {
    const p = ns.getPlayer();
    state("starting", { city: p.city });
    if (p.city !== "New Tokyo" && !sing.travelToCity("New Tokyo")) throw new Error("could not travel to New Tokyo");
    if (!ns.grafting.graftAugmentation(aug, focus)) throw new Error("graftAugmentation returned false");

    const started = Date.now();
    state("grafting", { city: "New Tokyo", started });
    event(`started grafting ${aug}`, { aug, focus });

    let waitError = "";
    try {
      await ns.grafting.waitForOngoingGrafting();
    } catch (e) {
      waitError = e instanceof Error ? e.message : String(e);
    }
    const ended = Date.now();
    const owned = sing.getOwnedAugmentations(false).includes(aug);
    if (owned) {
      state("done", { city: "New Tokyo", started, ended, owned: true });
      event(`finished grafting ${aug}`, { aug, durationMs: ended - started });
    } else {
      state(waitError ? "failed" : "cancelled", { city: "New Tokyo", started, ended, owned: false, error: waitError || undefined });
      event(`grafting ${aug} ended without the aug`, { aug, durationMs: ended - started, error: waitError || null });
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    state("failed", { city: ns.getPlayer().city, error });
    event(`grafting ${aug} failed: ${error}`, { aug, error });
  }
}
