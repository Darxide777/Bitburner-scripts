// Faction & augmentation planner. Pure logic → 0 GB (unit-testable outside the game).
//
// Each call looks at the current world (FactionData) and decides:
//   join      which invites to accept (city-faction conflicts resolved by aug value)
//   travelTo    where to go to trigger a city-locked invite
//   backdoor  which servers to backdoor for faction invites
//   work      which faction + work type gives the most aug value per second of rep grind
//   install   whether to buy everything now and install, and in what order
//   destroy   whether w0r1d_d43m0n can be destroyed
//
// Money is NOT spent on augs during a run: every purchase multiplies the price of
// all remaining augs by ~1.9, so buying everything at install time, most
// expensive first, is the cheapest order. The Red Pill is the exception.
import type { FactionData, FactionInfo } from "./data.js";
import { NFG, RED_PILL, SKIP_FACTIONS } from "./data.js";

const BLADEBURNERS = "Bladeburners";
/** every combat stat must reach this to join the Bladeburner division */
const BB_JOIN_STAT = 100;
const GYM_STAT = { strength: "str", defense: "def", dexterity: "dex", agility: "agi" } as const;
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
  /** Train combat to 100 and join Bladeburner before grinding factions (it can win the BitNode). */
  bladeburnerFirst: boolean;
  /** Extra value per aug on top of its stats (effects the stats don't show). */
  augBonus: Record<string, number>;
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
  bladeburnerFirst: true,
  // Church of the Machine God augs, wanted for the Stanek path: valued above their listed stats
  augBonus: { "Stanek's Gift - Awakening": 3, "Stanek's Gift - Serenity": 3 },
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
  /** Bladeburner actions may use the player's time (always with The Blade's Simulacrum). */
  bladeburner: boolean;
  /** Gym training (combat stat) to reach the Bladeburner division's 100-in-each requirement. */
  train: { stat: string; gym: string; city: string; focus: boolean } | null;
  /** Why destroy is (not) happening: Red Pill installed, w0r1d_d43m0n seen/rooted, hack level vs req. */
  worldDaemon: { redPill: boolean; exists: boolean; inScan?: boolean; rooted: boolean; reqHack: number; hackLevel: number };
  /** Fraction of money the economy module may spend on servers/RAM. */
  infraSpend: number;
  /** Augs that could be bought right now if we installed (purchase order). */
  ready: Candidate[];
  readyCost: number;
  /** Top candidates still blocked on rep or money (display list, truncated). */
  pending: (Candidate & { eta: number })[];
  /** Every joined, workable faction that still gates a wanted aug, most valuable first (for sleeves). */
  grindFactions: string[];
  /**
   * Joined, workable factions nobody needs to grind for augs, best first, for spare sleeves:
   * rep becomes favor at install (×rep gain later, donations at the threshold), so those
   * about to unlock donations come first, then the ones with the most unowned value.
   */
  favorFactions: string[];
  /** Number of wanted augs still gated on rep, per (best-source) faction. Not truncated. */
  repGated: Record<string, number>;
  nextEta: number;
  notes: string[];
}

export interface PlanInput {
  data: FactionData;
  /** Observed rep/s per faction (from metrics), used when it beats the formula estimate. */
  observedRep: Record<string, number>;
  income: number; // $/s
  sinceInstall: number; // ms
  /** Faction the player is working for right now, if any (keeps the NeuroFlux grind from hopping). */
  currentWork?: string | null;
  /**
   * false right after a daemon (re)start: observed rates are still empty, so rep that only
   * has an observed rate (Church, gang factions…) would look infinitely far away. ETA-based
   * installs wait for this (default true).
   */
  ratesReady?: boolean;
  /** Bladeburner manager state: in the division, and whether actions can run alongside work. */
  bladeburner?: { inDivision: boolean; simulacrum: boolean; canJoin?: boolean };
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
  const value = (a: string) =>
    a === RED_PILL ? 1e6 : augValue(data.augs[a].stats, cfg.weights) + (cfg.augBonus[a] ?? 0);

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
  // factions that offer no work refuse donations (Bladeburners: rank only; Church of the
  // Machine God: Stanek charging only)
  const canDonate = (f: string) =>
    F[f].favor >= data.favorToDonate &&
    data.repPerDollar > 0 &&
    f !== data.gangFaction &&
    f !== BLADEBURNERS &&
    F[f].workTypes.length > 0;

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
  // with the Simulacrum, actions run alongside whatever work is chosen
  let bladeburner = !!input.bladeburner?.inDivision && !!input.bladeburner.simulacrum;
  let train: Plan["train"] = null;
  const bbIn = input.bladeburner;
  // one stat at a time, in a fixed order: picking the lowest would hop every tick while
  // they're all close, restarting the workout each time
  const short = (["strength", "defense", "dexterity", "agility"] as const).find((k) => (data.skills[k] ?? 0) < BB_JOIN_STAT);
  if (cfg.manageWork && cfg.bladeburnerFirst && bbIn?.canJoin && !bbIn.inDivision && short) {
    train = { stat: GYM_STAT[short], gym: "Powerhouse Gym", city: "Sector-12", focus: cfg.focus && !data.hasNeuroreceptor };
    notes.push(`training ${short} (${Math.floor(data.skills[short] ?? 0)}/${BB_JOIN_STAT}) to join Bladeburner`);
  } else if (cfg.manageWork) {
    const grind = pending.filter((c) => c.repGap > 0 && c.donation === 0 && F[c.faction].bestWork && F[c.faction].joined);
    const target = grind.sort((a, b) => b.value / Math.max(1, b.repEta) - a.value / Math.max(1, a.repEta))[0];
    if (target) {
      work = { faction: target.faction, type: F[target.faction].bestWork!, focus: cfg.focus && !data.hasNeuroreceptor };
      notes.push(`grinding ${target.faction} for ${target.aug} (${fmtS(target.repEta)})`);
    } else {
      // nothing the player can grind: build rep for NeuroFlux in the best faction, else crime (karma for the gang)
      const gangGated = pending.filter((c) => c.repGap > 0 && c.faction === data.gangFaction).length;
      const why = gangGated ? `${gangGated} augs wait on ${data.gangFaction} (gang respect)` : "no rep-gated augs left";
      const nfgFaction = bestNfgFaction(data, true, input.currentWork);
      const bb = input.bladeburner;
      const bbAugsLeft = (F[BLADEBURNERS]?.augs ?? ["?"]).some((a) => a !== NFG && !owned.has(a));
      if (bb?.inDivision && !bb.simulacrum && bbAugsLeft) {
        bladeburner = true; // rank → Bladeburners rep, ahead of NeuroFlux and crime
        notes.push(`${why}; Bladeburner actions for Bladeburners rep`);
      } else if (nfgFaction) {
        work = { faction: nfgFaction, type: F[nfgFaction].bestWork!, focus: cfg.focus && !data.hasNeuroreceptor };
        notes.push(`${why}; building ${nfgFaction} rep for NeuroFlux`);
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
    else if (input.ratesReady !== false && newAugs >= cfg.minAugsToInstall && nextEta > cfg.installPatience * since)
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
    travelTo: train ? null : travelTo, // stay at the gym while training
    backdoor,
    work,
    crime,
    buyNow,
    install,
    destroy,
    bladeburner,
    train,
    worldDaemon: { redPill: data.installed.includes(RED_PILL), ...data.worldDaemon, hackLevel: data.hackLevel },
    infraSpend,
    ready,
    readyCost: readyCost + donations,
    pending: pending.slice(0, 8),
    favorFactions: joined
      .filter((f) => usable(f) && f !== data.gangFaction && F[f].workTypes.length > 0)
      .filter((f) => !pending.some((c) => c.faction === f && c.repGap > 0 && c.donation === 0))
      .sort((a, b) => {
        const below = (f: string) => (F[f].favor < data.favorToDonate ? 1 : 0);
        return (
          below(b) - below(a) ||
          F[b].favor + F[b].favorGain - (F[a].favor + F[a].favorGain) ||
          unownedValue(b) - unownedValue(a)
        );
      }),
    repGated: pending
      .filter((c) => c.repGap > 0 && c.donation === 0)
      .reduce<Record<string, number>>((acc, c) => ((acc[c.faction] = (acc[c.faction] ?? 0) + 1), acc), {}),
    grindFactions: [
      ...new Set(
        pending
          .filter((c) => c.repGap > 0 && c.donation === 0 && F[c.faction]?.joined && F[c.faction].workTypes.length > 0)
          .map((c) => c.faction),
      ),
    ],
    nextEta,
    notes,
  };
}

/** Another faction must be this much faster before the NeuroFlux grind switches to it. */
const NFG_SWITCH_MARGIN = 1.1;

/**
 * Joined faction selling NeuroFlux Governor to build rep in (optionally: one we can work for).
 *
 * NeuroFlux costs the same rep everywhere, so the best place is where work earns rep
 * fastest: highest workRepPerSec, which includes favor and is stable within a run.
 * (Ranking by current rep made it hop every tick: sleeves grind every faction except
 * the player's, so the one the player left would soon be overtaken by the others.)
 * `current` is kept unless another faction is NFG_SWITCH_MARGIN× faster.
 */
export function bestNfgFaction(data: FactionData, workableOnly = false, current?: string | null): string | null {
  const ok = Object.entries(data.factions).filter(
    ([, fi]) => fi.joined && fi.augs.includes(NFG) && (!workableOnly || fi.bestWork),
  );
  if (!ok.length) return null;
  const rate = (fi: FactionInfo) => fi.workRepPerSec;
  ok.sort(([, a], [, b]) => rate(b) - rate(a) || b.favor - a.favor || b.rep - a.rep);
  const [best, bestInfo] = ok[0];
  const cur = current ? ok.find(([f]) => f === current) : undefined;
  if (cur && rate(cur[1]) * NFG_SWITCH_MARGIN >= rate(bestInfo)) return cur[0];
  return best;
}

function fmtS(s: number): string {
  if (!Number.isFinite(s)) return "∞";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
