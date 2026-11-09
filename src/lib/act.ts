// Carries out the cheap, immediate parts of a faction plan, from the daemon, through the
// call proxy: one temporary script per game function (peak ~6.6 GB), instead of a task
// that references all of them at once (tasks/factions-act.js cost ~34 GB on every run, and
// as the biggest recurring task it set the home RAM reserve).
import type { NS } from "@ns";
import { call, callEach } from "./call.js";
import { KARMA_PER_SEC } from "./plan/sleeves.js";

export interface ActArgs {
  join: string[];
  travelTo: string | null;
  work: { faction: string; type: string; focus: boolean } | null;
  crime: string | null;
  buyNow: [string, string][];
  /** gym workout (takes precedence over work/crime) */
  train?: { stat: string; gym: string; city: string; focus: boolean } | null;
  /** company work for a faction invite (after training, before faction work) */
  company?: { company: string; field: string; focus: boolean } | null;
  /** a university course for a skill gate (after training, before company work) */
  study?: { university: string; city: string; course: string; focus: boolean } | null;
}

interface CurrentWork {
  type?: string;
  factionName?: string;
  factionWorkType?: string;
  crimeType?: string;
  classType?: string;
  location?: string;
  companyName?: string;
}

const S = "singularity.";

/** Do it; returns human-readable actions taken. `city` = where the player is now. */
export async function act(ns: NS, a: ActArgs, city: string): Promise<string[]> {
  const done: string[] = [];
  const joined = await callEach<boolean>(ns, S + "joinFaction", a.join.map((f) => [f]));
  a.join.forEach((f, k) => joined[k] && done.push(`joined ${f}`));

  if (a.travelTo && city !== a.travelTo && (await call<boolean>(ns, S + "travelToCity", a.travelTo))) {
    done.push(`travelled to ${a.travelTo}`);
    city = a.travelTo;
  }

  const bought = await callEach<boolean>(ns, S + "purchaseAugmentation", a.buyNow);
  a.buyNow.forEach(([, aug], k) => bought[k] && done.push(`bought ${aug}`));

  const cur = (await call<CurrentWork | null>(ns, S + "getCurrentWork")) ?? null;
  if (a.train) {
    const t = a.train;
    const same = cur?.type === "CLASS" && cur.classType === t.stat && cur.location === t.gym;
    if (!same) {
      if (city !== t.city && (await call<boolean>(ns, S + "travelToCity", t.city))) done.push(`travelled to ${t.city}`);
      if (await call<boolean>(ns, S + "gymWorkout", t.gym, t.stat, t.focus)) done.push(`training ${t.stat} at ${t.gym}`);
    }
  } else if (a.study) {
    const s = a.study;
    const same = cur?.type === "CLASS" && cur.classType === s.course && cur.location === s.university;
    if (!same) {
      if (city !== s.city && (await call<boolean>(ns, S + "travelToCity", s.city))) done.push(`travelled to ${s.city}`);
      if (await call<boolean>(ns, S + "universityCourse", s.university, s.course, s.focus)) done.push(`studying ${s.course} at ${s.university}`);
    }
  } else if (a.company) {
    const c = a.company;
    // applying again while employed is how promotions happen (null = nothing better)
    const job = await call<string | null>(ns, S + "applyToCompany", c.company, c.field);
    if (job) done.push(`job at ${c.company}: ${job}`);
    const same = cur?.type === "COMPANY" && cur.companyName === c.company;
    if ((!same || job) && (await call<boolean>(ns, S + "workForCompany", c.company, c.focus))) done.push(`working at ${c.company}`);
  } else if (a.work) {
    const w = a.work;
    const same = cur?.type === "FACTION" && cur.factionName === w.faction && cur.factionWorkType === w.type;
    if (!same && (await call<boolean>(ns, S + "workForFaction", w.faction, w.type, w.focus))) done.push(`working for ${w.faction} (${w.type})`);
  } else if (a.crime) {
    // karma per second (only successes count): Homicide 3/3 s vs Mug 0.25/4 s, so Mug only
    // when Homicide's chance is under ~6% of Mug's
    let crime = a.crime;
    if (crime === "Homicide") {
      const [h, m] = await callEach<number>(ns, S + "getCrimeChance", [["Homicide"], ["Mug"]]);
      if ((h ?? 0) * KARMA_PER_SEC.Homicide < (m ?? 1) * KARMA_PER_SEC.Mug) crime = "Mug";
    }
    if (!(cur?.type === "CRIME" && cur.crimeType === crime)) {
      await call(ns, S + "commitCrime", crime, false);
      done.push(`committing ${crime}`);
    }
  }
  return done;
}
