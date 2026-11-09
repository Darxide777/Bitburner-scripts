// Infiltration autoplayer (decisions in lib/plan/infiltration.ts).
//
//   run infiltrate.js <faction>    (the daemon starts it when infiltration beats faction work)
//
// The game rejects scripted key presses on purpose (an untrusted keydown hospitalizes you),
// so this never dispatches key events. It finds the infiltration object through React's
// fiber tree and calls the active minigame model's own onKey() with keys computed from that
// model's state. Before every key it checks the same minigame is still active, since a key
// sent to a finished stage would count as a failure.
//
// Loop: pick the best target (measured rep/s, else the info API) → travel → go to the
// company → "Infiltrate Company" → "Start" → play every level → trade the intel for rep with
// <faction> (sell for cash if that's impossible) → record the measured result. Stops when
// data/infiltration-config.txt says so, HP gets low, or a run fails.
// Uses the DOM (25 GB while running); everything else goes through the call proxy.
import type { NS } from "@ns";
import { call } from "./lib/call.js";
import { appendJsonl, readJson, writeJson } from "./lib/io.js";
import { DATA } from "./lib/paths.js";
import {
  chooseTarget,
  DEFAULT_INFILTRATION,
  nextStep,
  recordRun,
  type InfiltrationConfig,
  type Measured,
  type Model,
  type TargetInfo,
} from "./lib/plan/infiltration.js";

export interface InfiltrationControl {
  /** keep going (not `run`: property names that match API functions cost RAM) */
  active: boolean;
  faction: string | null;
  cfg?: Partial<InfiltrationConfig>;
}

export interface InfiltrationState {
  t: number;
  measured: Record<string, Measured>;
  runs: number;
  failures: number;
  lastRun: { target: string; faction: string; rep: number; cash: number; seconds: number; ok: boolean } | null;
  note: string;
}

interface InfilObj {
  stage: Model & { onKey: (e: unknown) => void };
  level: number;
  maxLevel: number;
  results: string;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const doc = document;
  const faction = String(ns.args[0] ?? "");
  const st = readJson<InfiltrationState>(ns, DATA.infiltration, { t: 0, measured: {}, runs: 0, failures: 0, lastRun: null, note: "" });
  const event = (msg: string) => appendJsonl(ns, DATA.events, { t: Date.now(), kind: "infiltration", msg });
  const save = (note: string) => {
    writeJson(ns, DATA.infiltration, { ...st, t: Date.now(), note });
    if (note) event(note);
  };

  while (true) {
    const ctl = readJson<InfiltrationControl>(ns, DATA.infiltrationConfig, { active: false, faction: null });
    const cfg: InfiltrationConfig = { ...DEFAULT_INFILTRATION, ...ctl.cfg };
    if (!ctl.active || ctl.faction !== faction) return save("stopped by the daemon");
    const p = ns.getPlayer();
    if (p.hp.current < p.hp.max * cfg.minHpFrac) return save(`stopped: HP ${p.hp.current}/${p.hp.max}`);

    // ---- target ----
    const locations = ns.infiltration.getPossibleLocations();
    const targets: TargetInfo[] = [];
    for (const loc of locations) {
      const info = await call<{ difficulty: number; maxClearanceLevel: number; reward: { tradeRep: number; sellCash: number } }>(
        ns,
        "infiltration.getInfiltration",
        loc.name,
      );
      if (info)
        targets.push({
          name: loc.name,
          city: loc.city,
          difficulty: info.difficulty,
          levels: info.maxClearanceLevel,
          tradeRep: info.reward.tradeRep,
          sellCash: info.reward.sellCash,
        });
    }
    const pick = chooseTarget(targets, st.measured, cfg);
    if (!pick) return save("no location below the difficulty cap");
    const t = pick.target;

    // ---- get there and start ----
    if (p.city !== t.city && !(await call<boolean>(ns, "singularity.travelToCity", t.city))) return save(`couldn't travel to ${t.city}`);
    if (!(await call<boolean>(ns, "singularity.goToLocation", t.name))) return save(`couldn't go to ${t.name}`);
    const infilBtn = await waitFor(ns, () => button(doc, (s) => s === "Infiltrate Company"), 3000);
    if (!infilBtn) return save(`no "Infiltrate Company" button at ${t.name}`);
    press(infilBtn);
    const startBtn = await waitFor(ns, () => button(doc, (s) => s === "Start"), 3000);
    if (!startBtn) return save("no Start button");
    const repBefore = (await call<number>(ns, "singularity.getFactionRep", faction)) ?? 0;
    const cashBefore = ns.getServerMoneyAvailable("home");
    const started = Date.now();
    press(startBtn);

    // ---- play ----
    let ok = false;
    let missingSince = 0;
    let lastResults = "";
    for (let guard = 0; guard < 20_000; guard++) {
      if (findText(doc, "Infiltration successful!")) {
        ok = true;
        break;
      }
      const state = findInfiltration(doc);
      if (!state) {
        // React may not have re-rendered yet (e.g. right after Start): only a sustained
        // absence means it's gone (cancelled, hospitalized, or the page changed)
        missingSince ||= Date.now();
        if (Date.now() - missingSince > 2000) break;
        await ns.sleep(25);
        continue;
      }
      missingSince = 0;
      lastResults = state.results;
      const model = state.stage;
      const step = nextStep(model);
      if ("wait" in step) {
        await ns.sleep(10);
        continue;
      }
      for (const key of step.keys) {
        if (state.stage !== model) break; // the stage moved on: never feed a stale model
        model.onKey({ key, preventDefault() {} });
        await ns.sleep(15);
      }
    }

    // ---- reward ----
    let traded = false;
    if (ok) {
      traded = await chooseFaction(ns, doc, faction);
      const btn = traded ? button(doc, (s) => s.startsWith("Trade for")) : button(doc, (s) => s.startsWith("Sell for"));
      if (btn) press(btn);
      await ns.sleep(300);
    }
    const seconds = (Date.now() - started) / 1000;
    const rep = ((await call<number>(ns, "singularity.getFactionRep", faction)) ?? 0) - repBefore;
    const cash = ns.getServerMoneyAvailable("home") - cashBefore;
    st.runs++;
    if (!ok) st.failures++;
    if (ok && traded && rep > 0) st.measured[t.name] = recordRun(st.measured[t.name], rep, seconds);
    st.lastRun = { target: t.name, faction, rep, cash, seconds, ok };
    event(
      ok
        ? `${t.name}: ${traded ? `+${ns.format.number(rep)} ${faction} rep` : `sold for $${ns.format.number(cash)}`} in ${seconds.toFixed(0)}s`
        : `${t.name}: run failed after ${seconds.toFixed(1)}s (results ${lastResults || "none"})`,
    );
    save(ok ? "" : "last run failed");
    if (!ok) return; // don't keep losing HP: the daemon decides whether to try again
  }
}

/** The Infiltration object: every stage component gets it as its `state` prop. */
function findInfiltration(doc: Document): InfilObj | null {
  for (const el of doc.querySelectorAll("h5, button")) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let f = key ? (el as unknown as Record<string, FiberNode>)[key] : undefined;
    for (let depth = 0; f && depth < 40; depth++, f = f.return) {
      const s = f.memoizedProps?.state as InfilObj | undefined;
      if (s && typeof s === "object" && s.stage && typeof s.stage.onKey === "function" && "maxLevel" in s) return s;
    }
  }
  return null;
}

interface FiberNode {
  return?: FiberNode;
  memoizedProps?: Record<string, unknown>;
}

/** Pick `faction` in the Victory screen's dropdown via its own onChange; false if not offered. */
async function chooseFaction(ns: NS, doc: Document, faction: string): Promise<boolean> {
  if (!faction) return false;
  const combo = doc.querySelector('[role="combobox"]');
  if (!combo) return false;
  const key = Object.keys(combo).find((k) => k.startsWith("__reactFiber$"));
  let f = key ? (combo as unknown as Record<string, FiberNode>)[key] : undefined;
  for (let depth = 0; f && depth < 30; depth++, f = f.return) {
    const props = f.memoizedProps;
    if (props && typeof props.onChange === "function" && "value" in props) {
      (props.onChange as (e: unknown) => void)({ target: { value: faction } });
      await ns.sleep(100);
      const btn = button(doc, (s) => s.startsWith("Trade for"));
      return !!btn && !btn.disabled;
    }
  }
  return false;
}

/** Call the button's React onClick (falls back to click()). These buttons accept either. */
function press(el: HTMLElement): void {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const props = key ? (el as unknown as Record<string, { onClick?: (e: unknown) => void }>)[key] : undefined;
  if (props?.onClick) props.onClick({ isTrusted: true, type: "click", target: el, currentTarget: el, button: 0, preventDefault() {}, stopPropagation() {} });
  else el.click();
}

function button(doc: Document, match: (text: string) => boolean): HTMLButtonElement | null {
  for (const b of doc.querySelectorAll("button")) if (match((b.textContent ?? "").trim())) return b;
  return null;
}

function findText(doc: Document, text: string): boolean {
  for (const el of doc.querySelectorAll("h4, h5")) if ((el.textContent ?? "").includes(text)) return true;
  return false;
}

async function waitFor<T>(ns: NS, probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = probe();
    if (v) return v;
    await ns.sleep(25);
  }
  return null;
}
