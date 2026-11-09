// Bladeburner manager: joins the division and faction, buys skills, picks the city and
// runs actions (decisions in lib/plan/bladeburner.ts).
// Steered by data/bladeburner-config.txt, written by the daemon:
//   canJoin    joining is safe: with SF7.3 it grants The Blade's Simulacrum, which blocks
//              accepting Stanek's Gift, so the daemon only allows it once Stanek is settled
//   usePlayer  may run actions (always with Simulacrum, otherwise only when the player has
//              nothing better to do); skills/city/faction are managed regardless
import type { BladeburnerActionName, BladeburnerActionType, BladeburnerSkillName, CityName, NS } from "@ns";
import { readJson, writeJson } from "../lib/io.js";
import {
  chooseAction,
  DEFAULT_BB,
  pickSkill,
  SKILL_WEIGHTS,
  TYPE,
  type BbAction,
  type BbActionInfo,
  type BbConfig,
} from "../lib/plan/bladeburner.js";
import { DATA } from "../lib/paths.js";

export interface BladeburnerControl {
  canJoin: boolean;
  usePlayer: boolean;
  cfg?: Partial<BbConfig>;
}

export interface BladeburnerStatus {
  t: number;
  inDivision: boolean;
  rank: number;
  stamina: [number, number];
  city: string;
  chaos: number;
  action: BbAction | null;
  why: string;
  skillPoints: number;
  skillsBought: number;
  note: string;
}

const CITIES: CityName[] = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"] as CityName[];
const CITY_EVERY_MS = 60_000;
/** another city must have this much more (estimated) population to move there */
const CITY_MARGIN = 1.1;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const B = ns.bladeburner;
  let resting = false;
  let started = null as { key: string; at: number; ms: number } | null;
  let lastCity = 0;
  let skillsBought = 0;

  while (true) {
    const ctl = readJson<BladeburnerControl>(ns, DATA.bladeburnerConfig, { canJoin: false, usePlayer: false });
    const cfg: BbConfig = { ...DEFAULT_BB, ...ctl.cfg };
    const status: BladeburnerStatus = {
      t: Date.now(),
      inDivision: B.inBladeburner(),
      rank: 0,
      stamina: [0, 0],
      city: "",
      chaos: 0,
      action: null,
      why: "",
      skillPoints: 0,
      skillsBought,
      note: "",
    };

    // ---- join ----
    if (!status.inDivision) {
      if (!ctl.canJoin) status.note = "waiting for Stanek's Gift before joining (SF7.3 Simulacrum blocks it)";
      else if (B.joinBladeburnerDivision()) status.inDivision = true;
      else status.note = "can't join yet: needs all combat stats ≥ 100";
      if (!status.inDivision) {
        writeJson(ns, DATA.bladeburner, status);
        await ns.sleep(10_000);
        continue;
      }
    }
    status.rank = B.getRank();
    if (status.rank >= 25) B.joinBladeburnerFaction(); // true if already a member

    // ---- skills ----
    for (let i = 0; i < 500; i++) {
      const points = B.getSkillPoints();
      const levels: Record<string, number> = {};
      const costs: Record<string, number> = {};
      for (const s of Object.keys(SKILL_WEIGHTS) as BladeburnerSkillName[]) {
        levels[s] = B.getSkillLevel(s);
        costs[s] = B.getSkillUpgradeCost(s, 1);
      }
      const pick = pickSkill(points, levels, costs);
      if (!pick || !B.upgradeSkill(pick as BladeburnerSkillName, 1)) break;
      skillsBought++;
    }
    status.skillPoints = B.getSkillPoints();
    status.skillsBought = skillsBought;

    // ---- city: success chances scale with the (estimated) population ----
    if (Date.now() - lastCity > CITY_EVERY_MS) {
      lastCity = Date.now();
      const here = B.getCity();
      const pop = (c: CityName) => B.getCityEstimatedPopulation(c);
      const best = CITIES.reduce((a, b) => (pop(b) > pop(a) ? b : a));
      if (best !== here && pop(best) > pop(here) * CITY_MARGIN) B.switchCity(best);
    }
    status.city = B.getCity();
    status.chaos = B.getCityChaos(status.city as CityName);
    status.stamina = B.getStamina();

    // ---- action ----
    if (!ctl.usePlayer) {
      status.note = "player busy with higher-value work";
      writeJson(ns, DATA.bladeburner, status);
      await B.nextUpdate();
      continue;
    }
    const info = (type: BladeburnerActionType, name: BladeburnerActionName): BbActionInfo => ({
      type: type as BbAction["type"],
      name,
      chance: B.getActionEstimatedSuccessChance(type, name) as [number, number],
      count: B.getActionCountRemaining(type, name),
      time: B.getActionTime(type, name),
      rankGain: B.getActionRankGain(type, name),
    });
    const actions = [
      ...B.getContractNames().map((n) => info(TYPE.contract as BladeburnerActionType, n)),
      ...B.getOperationNames().map((n) => info(TYPE.op as BladeburnerActionType, n)),
    ];
    const next = B.getNextBlackOp();
    const nextBlackOp = next ? { ...info(TYPE.blackOp as BladeburnerActionType, next.name), reqRank: next.rank } : null;
    const d = chooseAction({ stamina: status.stamina, chaos: status.chaos, rank: status.rank, actions, nextBlackOp, resting }, cfg);
    resting = d.resting;
    status.action = d.action;
    status.why = d.why;

    const cur = B.getCurrentAction();
    const key = `${d.action.type}/${d.action.name}`;
    const curKey = cur ? `${cur.type}/${cur.name}` : "";
    if (key !== curKey) {
      // switching mid-action throws its progress away: wait for the current one to finish,
      // unless we must rest/calm the city, or nothing of ours is running
      const urgent = d.action.name === "Hyperbolic Regeneration Chamber" || d.action.name === "Diplomacy";
      const speed = B.getBonusTime() > 1000 ? 5 : 1; // stored bonus time runs actions faster
      const done = !started || started.key !== curKey || Date.now() - started.at >= started.ms / speed;
      if (!cur || urgent || done) {
        if (B.startAction(d.action.type as BladeburnerActionType, d.action.name as BladeburnerActionName)) {
          started = { key, at: Date.now(), ms: B.getActionTime(d.action.type as BladeburnerActionType, d.action.name as BladeburnerActionName) };
        }
      }
    } else if (started?.key !== key) {
      started = { key, at: Date.now(), ms: B.getActionTime(d.action.type as BladeburnerActionType, d.action.name as BladeburnerActionName) };
    } else if (Date.now() - started.at >= started.ms) {
      started.at = Date.now(); // same action repeats: next cycle starts now
    }

    writeJson(ns, DATA.bladeburner, status);
    await B.nextUpdate();
  }
}
