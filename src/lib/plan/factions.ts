// Faction & augmentation planner. Pure logic → 0 GB (unit-testable outside the game).
//
// Each call looks at the current world (FactionData) and decides:
//   join      which invites to accept (city-faction conflicts resolved by aug value)
//   travelTo    where to go to trigger a city-locked invite
//   backdoor  which servers to backdoor for faction invites
//   work      which faction + work type gives the most aug value per second of rep grind
//   install   whether to buy everything now and install, and in what order
//   destroy   whether w0r1dd43m0n can be destroyed
//
// Money is NOT spent on augs during a run: every purchase multiplies the price of
// all remaining augs by ~1.9, so buying everything at install time, most
// expensive first, is the cheapest order. The Red Pill is the exception.
import type { FactionData } from "./data.js";
import { NFG, RED_PILL, SKIP_FACTIONS } from "./data.js";
import { evaluate, type ReqContext } from "./requirements.js";

export interface PlanConfig {
  /** Install when the next aug is further away than patience × time-since-install. */
  installPatience: number;
  minRunMs: number;
  maxRunMs: number;
  /** Minimum new augs (bought + queued) before an ETA-based install. */
  minAugsToInstall: number;
  autoInstall: boolean;
  autoDestroy: boolean;
  nextNode: number;
  /** Let the planner choose what the player works on. */
  manageWork: boolean;
  /** Unfocused work loses rep without Neuroreceptor; true = always focus when it matters. */
  focus: boolean;
  weights: Record<string, number>;
}

export const DEFAULT_PLAN: PlanConfig = {
  installPatience: 0.5,
  minRunMs: 20 * 60_000,
  maxRunMs: 6 * 3600_000,
  minAugsToInstall: 4,
  autoInstall: true,
  autoDestroy: true,
  nextNode: 12,
  manageWork: true,
  focus: true,
  // value of +100% in each multiplier (cost multipliers count as reductions)
  weights: {
    faction_rep: 4,
    company_rep: 1,
    hacking: 2.5,
    hacking_exp: 2,
    hacking_speed: 2,
    hacking_chance: 1,
    hacking_money: 1,
    hacking_grow: 0.5,
    charisma: 0.2,
    charisma_exp: 0.2,
    strength: 0.3,
    defense: 0.3,
    dexterity: 0.3,
    agility: 0.3,
    strength_exp: 0.3,
    defense_exp: 0.3,
    dexterity_exp: 0.3,
    agility_exp: 0.3,
    crime_money: 0.3,
    crime_success: 0.5,
    work_money: 0.2,
    dnet_money: 0.2,
    hacknet_node_money: 0.2,
    hacknet_node_purchase_cost: 0.1,
    hacknet_node_ram_cost: 0.1,
    hacknet_node_core_cost: 0.1,
    hacknet_node_level_cost: 0.1,
    bladeburner_max_stamina: 0.1,
    bladeburner_stamina_gain: 0.1,
    bladeburner_analysis: 0.1,
    bladeburner_success_chance: 0.1,
  },
};

/** Every aug counts toward Daedalus' install requirement, so nothing is worth 0. */
const BASE_VALUE = 0.05;
/** Rep penalty for unfocused work without Neuroreceptor. */
const UNFOCUSED = 0.8;

export interface Candidate {
  aug: string;
  faction: string; // best place to buy it
  value: number;
  price: number;
  repReq: number;
  repGap: number;
  /** Seconds of rep work needed (0 when donating covers it). */
  repEta: number;
  /** $ of donations needed to cover the rep gap (0 if none / not donate-able). */
  donation: number;
}

export interface Plan {
  join: string[];
  travelTo: string | null;
  backdoor: string[];
  work: { faction: string; type: string; focus: boolean } | null;
  /** Fallback activity when there is nothing to grind rep for. */
  crime: string | null;
  buyNow: [string, string][];
  install: null | { reason: string; buy: [string, string][]; donate: [string, number][] };
  destroy: boolean;
  /** Fraction of money the economy module may spend on servers/RAM. */
  infraSpend: number;
  /** Augs that could be bought right now if we installed (purchase order). */
  ready: Candidate[];
  readyCost: number;
  /** Top candidates still blocked on rep or money. */
  pending: (Candidate & { eta: number })[];
  nextEta: number;
  notes: string[];
}

export interface PlanInput {
  data: FactionData;
  /** Observed rep/s per faction (from metrics), used when it beats the formula estimate. */
  observedRep: Record<string, number>;
  income: number; // $/s
  sinceInstall: number; // ms
}

export function augValue(stats: Record<string, number>, weights: Record<string, number>): number {
  let v = BASE_VALUE;
  for (const [k, m] of Object.entries(stats)) {
    const w = weights[k] ?? 0;
    v += k.endsWith("_cost") ? w * (1 - m) : w * (m - 1);
  }
  return Math.max(BASE_VALUE, v);
}

/** Total $ to buy `prices` with escalation, most expensive first. */
export function escalatedCost(prices: number[], mult: number): number {
  return [...prices].sort((a, b) => b - a).reduce((sum, p, i) => sum + p * mult ** i, 0);
}

/**
 * Purchase order: most expensive first, except that a prerequisite must be bought
 * before the aug that needs it.
 */
export function purchaseOrder(names: string[], data: FactionData): string[] {
  const left = new Set(names);
  const out: string[] = [];
  const owned = new Set([...data.installed, ...data.queued]);
  while (left.size) {
    const ok = [...left].filter((a) => data.augs[a].prereqs.every((p) => owned.has(p) || out.includes(p)));
    // if a cycle/missing prereq slipped in, fall back to price order
    const pool = ok.length ? ok : [...left];
    pool.sort((a, b) => data.augs[b].price - data.augs[a].price);
    out.push(pool[0]);
    left.delete(pool[0]);
  }
  return out;
}

export function plan(input: PlanInput, cfg: PlanConfig = DEFAULT_PLAN): Plan {
  const { data } = input;
  const notes: string[] = [];
  const owned = new Set([...data.installed, ...data.queued]);
  const F = data.factions;
  const usable = (f: string) => !SKIP_FACTIONS.includes(f);
  const value = (a: string) => (a === RED_PILL ? 1e6 : augValue(data.augs[a].stats, cfg.weights));

  // ---------- which factions can we buy from ----------
  const joined = Object.keys(F).filter((f) => F[f].joined);
  const unownedValue = (f: string) =>
    F[f].augs.filter((a) => a !== NFG && !owned.has(a)).reduce((s, a) => s + value(a), 0);

  const join: string[] = [];
  for (const f of Object.keys(F)) {
    const fi = F[f];
    if (!fi.invited || fi.joined || !usable(f)) continue;
    if (fi.enemies.some((e) => F[e]?.joined || join.includes(e))) continue;
    const mine = unownedValue(f);
    if (fi.enemies.length === 0) {
      join.push(f);
      continue;
    }
    // city factions: join only if worth more than every enemy faction we'd lock out
    const best = Math.max(0, ...fi.enemies.map((e) => (F[e] ? unownedValue(e) : 0)));
    if (mine > 0 && mine >= best) join.push(f);
  }
  const member = new Set([...joined, ...join]);

  // ---------- candidates ----------
  const rate = (f: string) => {
    const base = F[f].workRepPerSec * (cfg.focus || data.hasNeuroreceptor ? 1 : UNFOCUSED);
    return Math.max(base, input.observedRep[f] ?? 0);
  };
  const canDonate = (f: string) => F[f].favor >= data.favorToDonate && data.repPerDollar > 0 && f !== data.gangFaction;

  const candidates: Candidate[] = [];
  for (const [a, info] of Object.entries(data.augs)) {
    if (owned.has(a) || a === NFG) continue;
    const sources = info.factions.filter((f) => member.has(f) && usable(f) && F[f]);
    if (!sources.length) continue;
    // best source: the one with the least rep left to earn
    let best = sources[0];
    for (const f of sources) if (F[f].rep > F[best].rep) best = f;
    const repGap = Math.max(0, info.repReq - F[best].rep);
    const donation = repGap > 0 && canDonate(best) ? repGap / data.repPerDollar : 0;
    const r = rate(best);
    candidates.push({
      aug: a,
      faction: best,
      value: value(a),
      price: info.price,
      repReq: info.repReq,
      repGap,
      repEta: donation > 0 ? 0 : repGap > 0 ? (r > 0 ? repGap / r : Infinity) : 0,
      donation,
    });
  }
  const byAug = new Map(candidates.map((c) => [c.aug, c]));
  const prereqsOk = (a: string, set: Set<string>) => data.augs[a].prereqs.every((p) => owned.has(p) || set.has(p));

  // ---------- what could we buy right now? (greedy by value, escalation-aware) ----------
  const chosen = new Set<string>();
  let readyCost = 0;
  let donations = 0;
  const readyPool = candidates
    .filter((c) => c.repGap === 0 || c.donation > 0)
    .sort((a, b) => b.value - a.value || b.price - a.price);
  // a few passes so prereqs chosen later can unlock dependents
  for (let pass = 0; pass < 3; pass++) {
    for (const c of readyPool) {
      if (chosen.has(c.aug) || !prereqsOk(c.aug, chosen)) continue;
      const prices = [...chosen, c.aug].map((a) => byAug.get(a)!.price);
      const cost = escalatedCost(prices, data.priceMult);
      if (cost + donations + c.donation > data.money) continue;
      chosen.add(c.aug);
      readyCost = cost;
      donations += c.donation;
    }
  }
  const order = purchaseOrder([...chosen], data);
  const ready = order.map((a) => byAug.get(a)!);

  // ---------- what's next, and how long until it's ours ----------
  const income = Math.max(0, input.income);
  const pending = candidates
    .filter((c) => !chosen.has(c.aug))
    .map((c) => {
      // total $ needed to buy the ready set plus this aug (escalation-aware), vs. money held
      const needed =
        escalatedCost([...chosen, c.aug].map((a) => byAug.get(a)!.price), data.priceMult) + donations + c.donation;
      const short = needed - data.money;
      const moneyEta = short <= 0 ? 0 : income > 0 ? short / income : Infinity;
      return { ...c, eta: Math.max(c.repEta, moneyEta) * 1000 };
    })
    // most value per second of waiting first
    .sort((a, b) => b.value / Math.max(1000, b.eta) - a.value / Math.max(1000, a.eta));
  const nextEta = Math.min(Infinity, ...pending.map((p) => p.eta));

  // ---------- work: best value-per-second rep grind ----------
  let work: Plan["work"] = null;
  let crime: string | null = null;
  if (cfg.manageWork) {
    const grind = pending.filter((c) => c.repGap > 0 && c.donation === 0 && F[c.faction].bestWork && F[c.faction].joined);
    const target = grind.sort((a, b) => b.value / Math.max(1, b.repEta) - a.value / Math.max(1, a.repEta))[0];
    if (target) {
      work = { faction: target.faction, type: F[target.faction].bestWork!, focus: cfg.focus && !data.hasNeuroreceptor };
      notes.push(`grinding ${target.faction} for ${target.aug} (${fmtS(target.repEta)})`);
    } else {
      // nothing rep-gated: build rep for NeuroFlux in the best faction, else crime (karma for the gang)
      const nfgFaction = bestNfgFaction(data, true);
      if (nfgFaction) {
        work = { faction: nfgFaction, type: F[nfgFaction].bestWork!, focus: cfg.focus && !data.hasNeuroreceptor };
        notes.push(`no rep-gated augs left; building ${nfgFaction} rep for NeuroFlux`);
      } else {
        crime = "Homicide";
        notes.push("nothing to grind; doing crime");
      }
    }
  }

  // ---------- travelTo & backdoors for invites we want ----------
  let travelTo: string | null = null;
  const backdoor: string[] = [];
  const ctx: ReqContext = {
    money: data.money,
    skills: data.skills,
    karma: data.karma,
    kills: data.kills,
    city: data.city,
    augsInstalled: data.installed.length,
    node: data.node,
    sourceFiles: data.sourceFiles,
    files: data.files,
    backdoors: data.backdoors,
    companyRep: {},
    jobs: data.jobs,
  };
  const wanted = Object.keys(F)
    .filter((f) => !F[f].joined && !F[f].invited && usable(f) && unownedValue(f) > 0)
    .filter((f) => !F[f].enemies.some((e) => member.has(e)))
    .sort((a, b) => unownedValue(b) - unownedValue(a));
  for (const f of wanted) {
    const r = evaluate(F[f].requirements, ctx);
    if (r.met || !r.fixes) continue;
    for (const fix of r.fixes) {
      if (fix.kind === "backdoor" && data.backdoorable.includes(fix.server) && !backdoor.includes(fix.server))
        backdoor.push(fix.server);
      if (fix.kind === "travel" && !travelTo && fix.city !== data.city && data.money > 2e5) {
        // only travelTo if that is the *only* thing missing
        if (r.fixes.every((x) => x.kind === "travel")) {
          travelTo = fix.city;
          notes.push(`travelling to ${fix.city} for ${f}`);
        }
      }
    }
  }

  // ---------- The Red Pill / destroy ----------
  const buyNow: [string, string][] = [];
  const redPill = byAug.get(RED_PILL);
  if (redPill && chosen.has(RED_PILL)) buyNow.push([redPill.faction, RED_PILL]);
  const destroy =
    cfg.autoDestroy &&
    data.installed.includes(RED_PILL) &&
    data.worldDaemon.exists &&
    data.worldDaemon.rooted &&
    data.hackLevel >= data.worldDaemon.reqHack;

  // ---------- install decision ----------
  let install: Plan["install"] = null;
  const newAugs = chosen.size + data.queued.length;
  const since = input.sinceInstall;
  const valuablePending = pending.filter((p) => p.value > BASE_VALUE);
  let reason = "";
  if (data.queued.includes(RED_PILL) || buyNow.length) reason = "The Red Pill";
  else if (newAugs > 0 && since >= cfg.minRunMs) {
    const favorUnlock = Object.keys(F).find(
      (f) =>
        F[f].joined &&
        F[f].favor < data.favorToDonate &&
        F[f].favor + F[f].favorGain >= data.favorToDonate &&
        unownedValue(f) > 0,
    );
    if (since >= cfg.maxRunMs) reason = `run exceeded ${fmtS(cfg.maxRunMs / 1000)}`;
    else if (!valuablePending.length) reason = "nothing valuable left to wait for";
    else if (newAugs >= cfg.minAugsToInstall && nextEta > cfg.installPatience * since)
      reason = `next aug in ${fmtS(nextEta / 1000)} > ${cfg.installPatience}× run time (${fmtS(since / 1000)})`;
    else if (favorUnlock) reason = `installing unlocks donations at ${favorUnlock}`;
  }
  if (reason && cfg.autoInstall) {
    install = {
      reason,
      buy: order.map((a) => [byAug.get(a)!.faction, a] as [string, string]),
      donate: ready.filter((c) => c.donation > 0).map((c) => [c.faction, c.donation] as [string, number]),
    };
  }

  // ---------- infra spending: spend early in a run, save as install approaches ----------
  const remaining = Number.isFinite(nextEta) ? nextEta : cfg.maxRunMs;
  const infraSpend = Math.min(0.5, Math.max(0.05, (0.5 * remaining) / (remaining + since + 1)));

  return {
    join,
    travelTo,
    backdoor,
    work,
    crime,
    buyNow,
    install,
    destroy,
    infraSpend,
    ready,
    readyCost: readyCost + donations,
    pending: pending.slice(0, 8),
    nextEta,
    notes,
  };
}

/** Joined faction with the most rep that sells NeuroFlux Governor (optionally: one we can work for). */
export function bestNfgFaction(data: FactionData, workableOnly = false): string | null {
  let best: string | null = null;
  for (const [f, fi] of Object.entries(data.factions)) {
    if (!fi.joined || !fi.augs.includes(NFG)) continue;
    if (workableOnly && !fi.bestWork) continue;
    if (!best || fi.rep > data.factions[best].rep) best = f;
  }
  return best;
}

function fmtS(s: number): string {
  if (!Number.isFinite(s)) return "∞";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
