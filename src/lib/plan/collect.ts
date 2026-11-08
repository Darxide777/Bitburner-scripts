// Builds FactionData using the RAM-minimal call proxy (lib/call.ts), so the peak
// RAM of a full faction/aug scan is ~1.6 GB + the single most expensive function,
// instead of the sum of all of them. Static aug data (stats, prereqs, sellers) is
// cached for the lifetime of the BitNode.
import type { Multipliers, NS, Player, PlayerRequirement, ResetInfo, Server } from "@ns";
import { callEach, call } from "../call.js";
import { allHosts } from "../net.js";
import { NEURORECEPTOR, type AugInfo, type FactionData, type FactionInfo } from "./data.js";

const PROGRAM_FILES = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe", "Formulas.exe"];

interface StaticAug {
  stats: Record<string, number>;
  prereqs: string[];
  factions: string[];
}
interface StaticFaction {
  enemies: string[];
  augs: string[];
}
const cache = {
  nodeReset: -1,
  augs: new Map<string, StaticAug>(),
  factions: new Map<string, StaticFaction>(),
};

/** Zip names with results of a per-name call. */
async function each<R>(ns: NS, fn: string, names: string[], extra: unknown[] = []): Promise<Map<string, R | undefined>> {
  const res = await callEach<R>(ns, fn, names.map((n) => [n, ...extra]));
  return new Map(names.map((n, i) => [n, res[i]]));
}

export async function collectFactionData(ns: NS): Promise<FactionData> {
  const S = "singularity.";
  const p = (await call<Player>(ns, "getPlayer"))!;
  const reset = (await call<ResetInfo & { ownedSF: Record<string, number> }>(ns, "getResetInfo"))!;
  if (cache.nodeReset !== reset.lastNodeReset) {
    cache.augs.clear();
    cache.factions.clear();
    cache.nodeReset = reset.lastNodeReset;
  }
  const [installed, withQueued] = (await callEach<string[]>(ns, S + "getOwnedAugmentations", [[false], [true]])) as string[][];
  const queued = withQueued.filter((a) => !installed.includes(a));
  const invites = new Set((await call<string[]>(ns, S + "checkFactionInvitations")) ?? []);
  const joined = new Set<string>(p.factions);
  const formulas = ns.fileExists("Formulas.exe", "home");

  let gangFaction: string | null = null;
  if (await call<boolean>(ns, "gang.inGang")) gangFaction = (await call<{ faction: string }>(ns, "gang.getGangInformation"))?.faction ?? null;

  // ---- factions ----
  const names = Object.values(ns.enums.FactionName) as string[];
  const newFactions = names.filter((f) => !cache.factions.has(f));
  if (newFactions.length) {
    const enemies = await each<string[]>(ns, S + "getFactionEnemies", newFactions);
    const augs = await each<string[]>(ns, S + "getAugmentationsFromFaction", newFactions);
    for (const f of newFactions) cache.factions.set(f, { enemies: enemies.get(f) ?? [], augs: augs.get(f) ?? [] });
  }
  const joinedList = names.filter((f) => joined.has(f));
  const notJoined = names.filter((f) => !joined.has(f));
  const favor = await each<number>(ns, S + "getFactionFavor", names);
  const rep = await each<number>(ns, S + "getFactionRep", joinedList);
  const favorGain = await each<number>(ns, S + "getFactionFavorGain", joinedList);
  const workable = joinedList.filter((f) => f !== gangFaction);
  const workTypes = await each<string[]>(ns, S + "getFactionWorkTypes", workable);
  const reqs = await each<PlayerRequirement[]>(ns, S + "getFactionInviteRequirements", notJoined);

  // best work type per faction via Formulas (per-cycle gains × 5 cycles/s)
  const gainArgs: [string, string][] = [];
  for (const f of workable) for (const w of workTypes.get(f) ?? []) gainArgs.push([f, w]);
  const gains = formulas
    ? await callEach<{ reputation: number }>(
        ns,
        "formulas.work.factionGains",
        gainArgs.map(([f, w]) => [p, w, favor.get(f) ?? 0]),
      )
    : [];

  const factions: Record<string, FactionInfo> = {};
  for (const f of names) {
    const st = cache.factions.get(f)!;
    let bestWork: string | null = null;
    let workRepPerSec = 0;
    gainArgs.forEach(([gf, w], i) => {
      if (gf !== f) return;
      const r = (gains[i]?.reputation ?? 0) * 5;
      if (r > workRepPerSec) {
        workRepPerSec = r;
        bestWork = w;
      }
    });
    const types = workTypes.get(f) ?? [];
    if (!formulas && types.length) bestWork = types.includes("hacking") ? "hacking" : types[0];
    factions[f] = {
      joined: joined.has(f),
      invited: invites.has(f),
      rep: rep.get(f) ?? 0,
      favor: favor.get(f) ?? 0,
      favorGain: favorGain.get(f) ?? 0,
      enemies: st.enemies,
      workTypes: types,
      bestWork,
      workRepPerSec,
      augs: st.augs,
      requirements: reqs.get(f) ?? [],
    };
  }

  // ---- augmentations ----
  const allAugs = [...new Set(names.flatMap((f) => cache.factions.get(f)!.augs))];
  const newAugs = allAugs.filter((a) => !cache.augs.has(a));
  if (newAugs.length) {
    const stats = await each<Multipliers>(ns, S + "getAugmentationStats", newAugs);
    const prereqs = await each<string[]>(ns, S + "getAugmentationPrereq", newAugs);
    const sellers = await each<string[]>(ns, S + "getAugmentationFactions", newAugs);
    for (const a of newAugs) {
      const diff: Record<string, number> = {};
      for (const [k, v] of Object.entries(stats.get(a) ?? {})) if (v !== 1) diff[k] = v as number;
      cache.augs.set(a, { stats: diff, prereqs: prereqs.get(a) ?? [], factions: sellers.get(a) ?? [] });
    }
  }
  // prices / rep requirements change (purchases, NeuroFlux levels) → always fresh, but only for unowned augs
  const owned = new Set(withQueued);
  const live = allAugs.filter((a) => !owned.has(a) || a === "NeuroFlux Governor");
  const prices = await each<number>(ns, S + "getAugmentationPrice", live);
  const repReqs = await each<number>(ns, S + "getAugmentationRepReq", live);
  const augs: Record<string, AugInfo> = {};
  for (const a of allAugs) {
    const st = cache.augs.get(a)!;
    augs[a] = { ...st, price: prices.get(a) ?? Infinity, repReq: repReqs.get(a) ?? Infinity };
  }

  // ---- servers (backdoors, w0r1dd43m0n) ----
  const hosts = allHosts(ns).filter((h) => h !== "home");
  const servers = await each<Server>(ns, "getServer", hosts);
  const backdoors: Record<string, boolean> = {};
  const backdoorable: string[] = [];
  let worldDaemon = { exists: false, rooted: false, reqHack: 0 };
  for (const h of hosts) {
    const s = servers.get(h);
    if (!s || s.purchasedByPlayer) continue;
    backdoors[h] = !!s.backdoorInstalled;
    if (h === "w0r1dd43m0n") {
      worldDaemon = { exists: true, rooted: s.hasAdminRights, reqHack: s.requiredHackingSkill ?? 0 };
      continue;
    }
    if (s.hasAdminRights && !s.backdoorInstalled && (s.requiredHackingSkill ?? 0) <= p.skills.hacking) backdoorable.push(h);
  }

  const sf = reset.ownedSF as unknown as Record<string, number>;
  const sf11 = sf["11"] ?? 0;
  return {
    t: Date.now(),
    money: p.money,
    hackLevel: p.skills.hacking,
    skills: { ...p.skills },
    karma: p.karma,
    kills: p.numPeopleKilled,
    city: p.city,
    node: reset.currentNode,
    sourceFiles: sf,
    installed,
    queued,
    favorToDonate: (await call<number>(ns, "getFavorToDonate")) ?? 150,
    repPerDollar: formulas ? ((await call<number>(ns, "formulas.reputation.repFromDonation", 1e9, p)) ?? 0) / 1e9 : 0,
    priceMult: 1.9 * [1, 0.96, 0.94, 0.93][Math.min(3, sf11)],
    hasNeuroreceptor: installed.includes(NEURORECEPTOR),
    gangFaction,
    files: PROGRAM_FILES.filter((f) => ns.fileExists(f, "home")),
    backdoors,
    backdoorable,
    factions,
    augs,
    worldDaemon,
    jobs: { ...p.jobs } as Record<string, string>,
  };
}
