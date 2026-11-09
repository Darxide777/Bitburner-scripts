// Sleeve assignment. Pure logic → 0 GB.
//
//   no gang yet (and karma not there): every sleeve commits Homicide (the fastest
//     karma), or Mug while Homicide would mostly fail → shortest time to gang
//   otherwise: one sleeve per faction we still need rep at (best sleeve for each, in
//     the planner's priority order), never the faction the player is working for
//     (the game doesn't allow two workers on one faction)
//   recovery rotation (default 1 slot): the most-shocked sleeve recovers — it produces the
//     least while shocked, so benching it costs the least — and hands over once another
//     sleeve is `margin` shock points worse (or it's done). data/sleeves.txt logs the
//     numbers to judge whether early recovery pays (tools/sleeve-shock.mjs)
//   then: Bladeburner contracts (one sleeve per contract, the game's limit) while in the
//     division with black ops left, for sleeves likely enough to succeed
//   then: spare sleeves build rep (→ favor at install) at factions nobody is grinding
//   leftovers: the best-paying crime they can pull off (or recovery with mode "spare")

export type Assignment =
  | { kind: "faction"; faction: string; type: string }
  | { kind: "crime"; crime: string }
  | { kind: "recovery" }
  | { kind: "bladeburner"; action: string; contract?: string };

export interface SleeveInfo {
  i: number;
  shock: number;
  /** current task, normalised to an Assignment (null = idle / something else) */
  current: Assignment | null;
  homicideChance: number;
  heistChance: number;
  /** rep/s by faction then work type */
  gains: Record<string, Record<string, number>>;
  /** Bladeburner contract → estimated success chance (min) for this sleeve */
  bbChance?: Record<string, number>;
}

export interface RecoveryConfig {
  /** "rotate": `slots` sleeves recover, rotating by shock; "spare": only leftover sleeves
   *  recover (old behavior); "off": never */
  mode: "rotate" | "spare" | "off";
  slots: number;
  /** hand the slot over once another sleeve has this many more shock points */
  margin: number;
  /** below this shock a sleeve doesn't need recovery */
  minShock: number;
}

export const DEFAULT_RECOVERY: RecoveryConfig = { mode: "rotate", slots: 1, margin: 5, minShock: 1 };

export interface BladeburnerSleeveInput {
  /** contracts with work left, best first */
  contracts: string[];
  minChance: number;
}

export interface SleeveInput {
  sleeves: SleeveInfo[];
  needKarma: boolean;
  /** factions to grind, most important first */
  targets: string[];
  /** lower-priority factions for spare sleeves (rep → favor) */
  favorTargets?: string[];
  playerFaction: string | null;
  recovery?: RecoveryConfig;
  /** set while sleeves should help Bladeburner (in the division, black ops left) */
  bladeburner?: BladeburnerSleeveInput | null;
}

/** Best karma per second (no gang yet). */
export function karmaCrime(s: SleeveInfo): string {
  return s.homicideChance >= 0.5 ? "Homicide" : "Mug";
}

/**
 * Best money per second. Base payouts: Heist ≈ $200k/s vs Homicide ≈ $15k/s, so Heist
 * wins whenever it succeeds at least ~10% of the time; we ask for 30% to limit failures.
 */
export function moneyCrime(s: SleeveInfo): string {
  return s.heistChance >= 0.3 ? "Heist" : karmaCrime(s);
}

export function decideSleeves(input: SleeveInput): Assignment[] {
  const out: (Assignment | null)[] = input.sleeves.map(() => null);
  if (input.needKarma) return input.sleeves.map((s) => ({ kind: "crime", crime: karmaCrime(s) }));

  const free = new Set(input.sleeves.map((_, idx) => idx));
  const rec = input.recovery ?? DEFAULT_RECOVERY;

  // 1. recovery rotation
  if (rec.mode === "rotate") for (const idx of recoveryPicks(input.sleeves, rec)) {
    out[idx] = { kind: "recovery" };
    free.delete(idx);
  }

  const assignFactions = (list: string[]) => {
    for (const f of list) {
      if (f === input.playerFaction || !free.size) continue;
      let bestIdx = -1;
      let bestType = "";
      let bestGain = 0;
      for (const idx of free) {
        for (const [type, g] of Object.entries(input.sleeves[idx].gains[f] ?? {})) {
          if (g > bestGain) {
            bestGain = g;
            bestIdx = idx;
            bestType = type;
          }
        }
      }
      if (bestIdx < 0) continue;
      out[bestIdx] = { kind: "faction", faction: f, type: bestType };
      free.delete(bestIdx);
    }
  };

  // 2. factions that gate augs we want
  assignFactions(input.targets);

  // 3. Bladeburner contracts: the most capable free sleeve per contract
  const bb = input.bladeburner;
  if (bb)
    for (const contract of bb.contracts) {
      let bestIdx = -1;
      let best = bb.minChance;
      for (const idx of free) {
        const c = input.sleeves[idx].bbChance?.[contract] ?? 0;
        if (c >= best) [bestIdx, best] = [idx, c];
      }
      if (bestIdx < 0) continue;
      out[bestIdx] = { kind: "bladeburner", action: "Take on contracts", contract };
      free.delete(bestIdx);
    }

  // 4. favor building, 5. leftovers
  assignFactions((input.favorTargets ?? []).filter((f) => !input.targets.includes(f)));
  for (const idx of free) {
    const s = input.sleeves[idx];
    out[idx] = rec.mode === "spare" && s.shock > 0 ? { kind: "recovery" } : { kind: "crime", crime: moneyCrime(s) };
  }
  return out as Assignment[];
}

/**
 * Which sleeves hold the recovery slots: current holders keep theirs until they're under
 * minShock or another sleeve is `margin` points more shocked; free slots go to the most
 * shocked. (Shock costs output in proportion, so benching the most-shocked costs least.)
 */
export function recoveryPicks(sleeves: SleeveInfo[], rec: RecoveryConfig): number[] {
  const needy = sleeves.filter((s) => s.shock >= rec.minShock).sort((a, b) => b.shock - a.shock);
  if (!needy.length || rec.slots <= 0) return [];
  const picks: SleeveInfo[] = [];
  for (const s of needy) if (s.current?.kind === "recovery" && picks.length < rec.slots) picks.push(s);
  // hand over: replace the least-shocked holder while an outsider beats it by the margin
  for (const s of needy) {
    if (picks.includes(s)) continue;
    if (picks.length < rec.slots) {
      picks.push(s);
      continue;
    }
    const weakest = picks.reduce((a, b) => (b.shock < a.shock ? b : a));
    if (s.shock >= weakest.shock + rec.margin) picks[picks.indexOf(weakest)] = s;
  }
  return picks.map((s) => s.i);
}

export function sameAssignment(a: Assignment | null, b: Assignment): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "faction" && b.kind === "faction") return a.faction === b.faction && a.type === b.type;
  if (a.kind === "crime" && b.kind === "crime") return a.crime === b.crime;
  if (a.kind === "bladeburner" && b.kind === "bladeburner") return a.action === b.action && a.contract === b.contract;
  return true;
}
