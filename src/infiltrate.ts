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
import { appendJsonl, appendLine, readJson, writeJson } from "./lib/io.js";
import { DATA } from "./lib/paths.js";
import {
  chooseTarget,
  DEFAULT_INFILTRATION,
  nextStep,
  recordFailure,
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
  /** failed runs in a row (the daemon's cooldown doubles with each) */
  consecutiveFailures?: number;
  /** runs where no level was ever attempted (a driver problem, not the location's fault) */
  driverErrors?: number;
  lastRun: { target: string; faction: string; rep: number; cash: number; seconds: number; ok: boolean } | null;
  note: string;
}

/** halves the HP lost per failed level */
const HARMONIZER = "SoA - phyzical WKS harmonizer";

interface InfilObj {
  /** Intro/Victory stages have no onKey */
  stage: Model & { onKey?: (e: unknown) => void };
  level: number;
  maxLevel: number;
  results: string;
  startInfiltration?: () => void;
  cancel?: () => void;
}

const TRACE = "data/infiltration-trace.txt";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const doc = document;
  const faction = String(ns.args[0] ?? "");
  const st = readJson<InfiltrationState>(ns, DATA.infiltration, { t: 0, measured: {}, runs: 0, failures: 0, lastRun: null, note: "" });
  const event = (msg: string) => appendJsonl(ns, DATA.events, { t: Date.now(), kind: "infiltration", msg });
  const trace = (msg: string) => appendLine(ns, TRACE, `${new Date().toISOString()} ${msg}`);
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
      const info = await call<{
        difficulty: number;
        maxClearanceLevel: number;
        startingSecurityLevel: number;
        reward: { tradeRep: number; sellCash: number };
      }>(
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
          startingSecurity: info.startingSecurityLevel,
        });
    }
    const harmonizer = (await call<string[]>(ns, "singularity.getOwnedAugmentations", false))?.includes(HARMONIZER) ?? false;
    const pick = chooseTarget(targets, st.measured, cfg, { current: p.hp.current, harmonizer });
    if (!pick) return save(`no location is safe enough: under difficulty ${cfg.maxDifficulty}, survivable (HP ${Math.floor(p.hp.current)}), and reliable`);
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
    // start through the object itself when we can see it (the button press is the fallback)
    cached = null; // a new run: a new object
    const atIntro = findInfiltration(doc);
    if (atIntro && typeof atIntro.startInfiltration === "function") atIntro.startInfiltration();
    else press(startBtn);

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
      if (typeof model.onKey !== "function") {
        // Intro (start didn't take) or Victory (not rendered yet): nudge Intro, else wait
        if (button(doc, (s) => s === "Start") && typeof state.startInfiltration === "function" && Date.now() - started > 1000) {
          trace("still at the intro after 1 s: calling startInfiltration() again");
          state.startInfiltration();
        }
        await ns.sleep(50);
        continue;
      }
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

    if (!ok) {
      const s = findInfiltration(doc);
      trace(
        `run ended without success: infiltration ${s ? `found (stage fields: ${Object.keys(s.stage).join(",")}; results "${s.results}")` : "not found"}; buttons: ${[...doc.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).filter(Boolean).slice(0, 15).join(" | ")}`,
      );
      // don't leave a stuck infiltration behind: its timers would keep failing levels (HP)
      if (s?.cancel) s.cancel();
      else {
        const cancelBtn = button(doc, (b) => b === "Cancel Infiltration" || b === "Cancel");
        if (cancelBtn) press(cancelBtn);
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
    // no level ever attempted = our driver failed, not the location: back off, but don't blame it
    const driverError = !ok && !lastResults;
    if (!ok) {
      st.failures++;
      st.consecutiveFailures = (st.consecutiveFailures ?? 0) + 1;
      if (driverError) st.driverErrors = (st.driverErrors ?? 0) + 1;
      else st.measured[t.name] = recordFailure(st.measured[t.name]);
    } else st.consecutiveFailures = 0;
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

const isInfil = (s: unknown): s is InfilObj =>
  !!s && typeof s === "object" && "stage" in s && "maxLevel" in s && typeof (s as InfilObj).stage === "object";

/** found once per run: the same object lives for the whole infiltration */
let cached: InfilObj | null = null;

/**
 * The Infiltration object. The screen's root component reads it directly (no props), so
 * walking *up* from its buttons never meets it; the stage components below get it as their
 * `state` prop. So: climb from any element to the top of the React tree, then search *down*
 * for the first component with such a prop. Cached while the screen is up.
 */
function findInfiltration(doc: Document): InfilObj | null {
  const onScreen = !!button(doc, (s) => s === "Cancel Infiltration" || s === "Start") || findText(doc, "Infiltration successful!");
  if (!onScreen) return (cached = null);
  if (cached) return cached;
  const el = doc.querySelector("button");
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  let top = key ? (el as unknown as Record<string, FiberNode>)[key] : undefined;
  while (top?.return) top = top.return;
  // iterative DFS over child/sibling links
  const stack: FiberNode[] = top ? [top] : [];
  for (let visited = 0; stack.length && visited < 50_000; visited++) {
    const f = stack.pop()!;
    const s = f.memoizedProps?.state;
    if (isInfil(s)) return (cached = s);
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return null;
}

interface FiberNode {
  return?: FiberNode;
  child?: FiberNode;
  sibling?: FiberNode;
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
