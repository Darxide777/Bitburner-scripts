// Evaluates the game's structured faction-invite requirements against what we
// know, and reports which requirements are unmet. Pure logic → 0 GB.
import type { PlayerRequirement } from "@ns";

export interface ReqContext {
  money: number;
  skills: Record<string, number>;
  karma: number;
  kills: number;
  city: string;
  augsInstalled: number;
  node: number;
  sourceFiles: Record<string, number>;
  files: string[];
  backdoors: Record<string, boolean>;
  /** company -> rep; company work isn't automated yet, so these usually fail. */
  companyRep: Record<string, number>;
  jobs: Record<string, string>;
}

/** A requirement we could satisfy by acting (travel, backdoor), vs. one we can only wait for. */
export type Fix = { kind: "travel"; city: string } | { kind: "backdoor"; server: string };

export interface ReqResult {
  met: boolean;
  /** Unmet requirements, flattened (for display / logging). */
  unmet: string[];
  /** Actions that would fix every unmet requirement, if all of them are fixable. */
  fixes: Fix[] | null;
}

export function evaluate(reqs: PlayerRequirement[], ctx: ReqContext): ReqResult {
  const unmet: string[] = [];
  const fixes: Fix[] = [];
  let fixable = true;
  for (const r of reqs) {
    const res = check(r, ctx);
    if (res.ok) continue;
    unmet.push(res.why);
    if (res.fix) fixes.push(res.fix);
    else fixable = false;
  }
  return { met: unmet.length === 0, unmet, fixes: unmet.length && fixable ? fixes : null };
}

interface Check {
  ok: boolean;
  why: string;
  fix?: Fix;
}

/** `>= n` for positive thresholds, `<= n` for non-positive ones (as documented by the game). */
const cmp = (have: number, want: number) => (want > 0 ? have >= want : have <= want);

function check(r: PlayerRequirement, c: ReqContext): Check {
  switch (r.type) {
    case "money":
      return { ok: c.money >= r.money, why: `money ≥ ${r.money}` };
    case "skills": {
      for (const [k, v] of Object.entries(r.skills)) {
        if ((c.skills[k] ?? 0) < (v ?? 0)) return { ok: false, why: `${k} ≥ ${v}` };
      }
      return { ok: true, why: "" };
    }
    case "karma":
      return { ok: cmp(c.karma, r.karma), why: `karma ${r.karma > 0 ? "≥" : "≤"} ${r.karma}` };
    case "numPeopleKilled":
      return { ok: c.kills >= r.numPeopleKilled, why: `kills ≥ ${r.numPeopleKilled}` };
    case "city":
      return { ok: c.city === r.city, why: `in ${r.city}`, fix: { kind: "travel", city: r.city } };
    case "backdoorInstalled":
      return {
        ok: !!c.backdoors[r.server],
        why: `backdoor ${r.server}`,
        fix: { kind: "backdoor", server: r.server },
      };
    case "numAugmentations":
      return { ok: c.augsInstalled >= r.numAugmentations, why: `${r.numAugmentations} augs installed` };
    case "file":
      return { ok: c.files.includes(r.file), why: `have ${r.file}` };
    case "bitNodeN":
      return { ok: c.node === r.bitNodeN, why: `in BN${r.bitNodeN}` };
    case "sourceFile":
      return { ok: (c.sourceFiles[String(r.sourceFile)] ?? 0) > 0, why: `SF${r.sourceFile}` };
    case "employedBy":
      return { ok: r.company in c.jobs, why: `employed by ${r.company}` };
    case "companyReputation":
      return { ok: (c.companyRep[r.company] ?? 0) >= r.reputation, why: `${r.company} rep ≥ ${r.reputation}` };
    case "jobTitle":
      return { ok: Object.values(c.jobs).includes(r.jobTitle), why: `job ${r.jobTitle}` };
    case "not": {
      const inner = check(r.condition, c);
      return { ok: !inner.ok, why: `not (${inner.why || "condition"})` };
    }
    case "someCondition": {
      const results = r.conditions.map((x) => check(x, c));
      if (results.some((x) => x.ok)) return { ok: true, why: "" };
      const fixable = results.find((x) => x.fix);
      return { ok: false, why: results.map((x) => x.why).join(" or "), fix: fixable?.fix };
    }
    case "everyCondition": {
      const results = r.conditions.map((x) => check(x, c));
      const bad = results.filter((x) => !x.ok);
      if (!bad.length) return { ok: true, why: "" };
      return { ok: false, why: bad.map((x) => x.why).join(" and "), fix: bad.length === 1 ? bad[0].fix : undefined };
    }
    default:
      // location, hacknet*, bladeburnerRank, numInfiltrations … not automated yet
      return { ok: false, why: r.type };
  }
}
