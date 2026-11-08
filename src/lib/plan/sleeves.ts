// Sleeve assignment. Pure logic → 0 GB.
//
//   no gang yet (and karma not there): every sleeve commits Homicide (the fastest
//     karma), or Mug while Homicide would mostly fail → shortest time to gang
//   otherwise: one sleeve per faction we still need rep at (best sleeve for each, in
//     the planner's priority order), never the faction the player is working for
//     (the game doesn't allow two workers on one faction)
//   then: spare sleeves build rep (→ favor at install) at factions nobody is grinding
//   leftovers: shock recovery while shocked, else the best-paying crime they can pull off

export type Assignment =
  | { kind: "faction"; faction: string; type: string }
  | { kind: "crime"; crime: string }
  | { kind: "recovery" };

export interface SleeveInfo {
  i: number;
  shock: number;
  /** current task, normalised to an Assignment (null = idle / something else) */
  current: Assignment | null;
  homicideChance: number;
  heistChance: number;
  /** rep/s by faction then work type */
  gains: Record<string, Record<string, number>>;
}

export interface SleeveInput {
  sleeves: SleeveInfo[];
  needKarma: boolean;
  /** factions to grind, most important first */
  targets: string[];
  /** lower-priority factions for spare sleeves (rep → favor) */
  favorTargets?: string[];
  playerFaction: string | null;
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
  const targets = [...input.targets, ...(input.favorTargets ?? []).filter((f) => !input.targets.includes(f))];
  for (const f of targets) {
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
  for (const idx of free) {
    const s = input.sleeves[idx];
    out[idx] = s.shock > 0 ? { kind: "recovery" } : { kind: "crime", crime: moneyCrime(s) };
  }
  return out as Assignment[];
}

export function sameAssignment(a: Assignment | null, b: Assignment): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "faction" && b.kind === "faction") return a.faction === b.faction && a.type === b.type;
  if (a.kind === "crime" && b.kind === "crime") return a.crime === b.crime;
  return true;
}
