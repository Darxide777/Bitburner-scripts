// Carries out the cheap, immediate parts of a faction plan.
// args: JSON {join, travelTo, work, crime, buyNow}
import type { CityName, CompanyName, CrimeType, FactionName, FactionWorkType, GymLocationName, GymType, JobField, NS } from "@ns";
import { task } from "../lib/task.js";

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
}

export async function main(ns: NS): Promise<void> {
  await task(ns, (args) => {
    const a = JSON.parse(String(args[0])) as ActArgs;
    const sing = ns.singularity;
    const done: string[] = [];

    for (const f of a.join) if (sing.joinFaction(f as FactionName)) done.push(`joined ${f}`);

    if (a.travelTo && ns.getPlayer().city !== a.travelTo && sing.travelToCity(a.travelTo as CityName))
      done.push(`travelled to ${a.travelTo}`);

    for (const [f, aug] of a.buyNow) if (sing.purchaseAugmentation(f as FactionName, aug)) done.push(`bought ${aug}`);

    const cur = sing.getCurrentWork();
    if (a.train) {
      const t = a.train;
      const same = cur?.type === "CLASS" && cur.classType === t.stat && cur.location === t.gym;
      if (!same) {
        if (ns.getPlayer().city !== t.city && sing.travelToCity(t.city as CityName)) done.push(`travelled to ${t.city}`);
        if (sing.gymWorkout(t.gym as GymLocationName, t.stat as GymType, t.focus)) done.push(`training ${t.stat} at ${t.gym}`);
      }
    } else if (a.company) {
      const c = a.company;
      // applying again while employed is how promotions happen (null = nothing better)
      const job = sing.applyToCompany(c.company as CompanyName, c.field as JobField);
      if (job) done.push(`job at ${c.company}: ${job}`);
      const same = cur?.type === "COMPANY" && cur.companyName === c.company;
      if ((!same || job) && sing.workForCompany(c.company as CompanyName, c.focus)) done.push(`working at ${c.company}`);
    } else if (a.work) {
      const same =
        cur?.type === "FACTION" && cur.factionName === a.work.faction && cur.factionWorkType === a.work.type;
      if (!same && sing.workForFaction(a.work.faction as FactionName, a.work.type as FactionWorkType, a.work.focus))
        done.push(`working for ${a.work.faction} (${a.work.type})`);
    } else if (a.crime) {
      const same = cur?.type === "CRIME" && cur.crimeType === a.crime;
      // fall back to a safer crime when the chosen one would mostly fail
      let crime = a.crime as CrimeType;
      if (sing.getCrimeChance(crime) < 0.5) crime = "Mug" as CrimeType;
      if (!same && !(cur?.type === "CRIME" && cur.crimeType === crime)) {
        sing.commitCrime(crime, false);
        done.push(`committing ${crime}`);
      }
    }
    return done;
  });
}
