// Blackjack save-scummer: wins the casino's $10b cap (per augment install) without losing.
//
//   run casino.js          (launcher: frees home RAM, then starts this script;
//                           the daemon also starts it early in a run when it's worth it)
//
// Loop: save the game → play one hand with basic strategy → on a loss, reload the page,
// which restores that save. The game restarts this script after the reload because it
// was running when the save was taken, so the loop just continues. Bets are
// min($100m max bet, your money); it stops once casino winnings since the last install
// reach $10b (more would only trigger the casino's "cheater" ban).
//
// Uses the DOM (the casino has no API), which costs 25 GB of RAM while it runs.
// Counters live in localStorage because in-game files roll back with every reload.
import type { NS } from "@ns";
import { DATA } from "../lib/paths.js";

const CAP = 10e9;
const MAX_BET = 100e6;
const MAX_RELOADS = 3000;
/** Money on hand past which the casino's $10b can't matter (100× the cap). */
const NOT_WORTH_IT = 100 * CAP;
const STATS_KEY = "bb-casino-stats";
const STATE_FILE = DATA.casino;

interface Stats {
  hands: number;
  wins: number;
  pushes: number;
  reloads: number;
  /** reloads for unexplained table states (not losses) */
  errors: number;
  started: number;
}
const MAX_ERRORS = 10;

type Outcome = "win" | "loss" | "push";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  ns.ui.openTail();
  /** progress goes to the terminal *and* this script's log window */
  const say = (msg: string) => {
    ns.print(msg);
    ns.tprint(`casino: ${msg}`);
    ns.write("data/casino-trace.txt", `${new Date().toISOString()} table ${msg}\n`, "a");
  };
  say("table script running");
  const doc = document;
  const win = doc.defaultView!;
  const store = win.localStorage;
  const stats: Stats = JSON.parse(store.getItem(STATS_KEY) ?? "null") ?? {
    hands: 0,
    wins: 0,
    pushes: 0,
    reloads: 0,
    errors: 0,
    started: Date.now(),
  };
  stats.errors ??= 0;
  const saveStats = () => store.setItem(STATS_KEY, JSON.stringify(stats));
  const casinoWinnings = () => ns.getMoneySources().sinceInstall.casino;

  const finish = (msg: string, ok = false) => {
    store.removeItem(STATS_KEY);
    // tells the daemon not to auto-start us again this install
    ns.write(STATE_FILE, JSON.stringify({ lastAugReset: ns.getResetInfo().lastAugReset, ok, msg, t: Date.now() }), "w");
    ns.tprint(`casino: ${msg} — ${stats.hands} hands, ${stats.wins} wins, ${stats.reloads} reloads (+${stats.errors} recoveries), ${ns.format.time(Date.now() - stats.started)}`);
  };

  if (casinoWinnings() >= CAP) return finish("already at the $10b cap for this install", true);
  // late game: $10b is noise, and every loss reloads the page (restarting every script)
  if (ns.getServerMoneyAvailable("home") >= NOT_WORTH_IT)
    return finish(`not worth it: already holding $${ns.format.number(ns.getServerMoneyAvailable("home"))}`, true);
  if (stats.reloads >= MAX_RELOADS) return finish(`stopped after ${MAX_RELOADS} reloads (safety cap)`);
  if (stats.errors > MAX_ERRORS) return finish(`stopped after ${MAX_ERRORS} reloads for unexpected table states`);

  /** Roll back to the save taken right before this hand. */
  const rollback = async (why: "loss" | "error") => {
    if (why === "loss") stats.reloads++;
    else stats.errors++;
    saveStats();
    win.location.reload();
    await ns.sleep(60_000); // the reload kills this script; never reached
  };

  // let the UI settle after a (re)load, then go to the blackjack table
  await ns.sleep(1500);
  if (!(await enterTable(ns, doc, say))) return finish("couldn't reach the blackjack table");
  say("at the blackjack table — starting");

  let stuck = 0;
  while (casinoWinnings() < CAP) {
    dismissPopups(doc);
    // small margin: anything else spending money between now and "Start" would make the
    // game reject the bet with a "You do not have enough money." popup
    const bet = Math.floor(Math.min(MAX_BET, ns.getServerMoneyAvailable("home") * 0.98));
    if (bet < 1) return finish("no money to bet");

    // 1. save — a loss below reloads back to exactly this point
    const saveBtn = doc.querySelector<HTMLButtonElement>('button[aria-label="save game"]');
    if (!saveBtn) return finish("couldn't find the save button");
    saveBtn.click();
    await ns.sleep(1000); // saveGame() is async (IndexedDB); give it time to land

    // 2. play
    const outcome = await playHand(ns, doc, bet);
    if (outcome === "retry") {
      // a hand in progress after all? it was dealt after the save → roll back
      if (button(doc, (t) => t === "Hit")) return rollback("error");
      // no hand happened (popup, page change…): clear popups, get back to the table, try again
      if (++stuck > 5) return finish("hands keep failing to start (see the last popup)");
      say(`hand didn't start (attempt ${stuck}): ${retryReason}; retrying`);
      dismissPopups(doc);
      if (!button(doc, (t) => t === "Start") && !(await enterTable(ns, doc, say)))
        return finish("lost the blackjack table and couldn't get back");
      continue;
    }
    // lost track mid-hand: the save is from just before it, so rolling back is always safe
    if (!outcome) return rollback("error");
    stuck = 0;
    stats.hands++;

    // 3. on a loss, roll back
    if (outcome === "loss") return rollback("loss");
    if (outcome === "win") stats.wins++;
    else stats.pushes++;
    saveStats();
    ns.print(`${outcome} $${ns.format.number(bet)} → winnings ${ns.format.number(casinoWinnings())} / 10b`);
  }

  // final save so the last win is kept
  doc.querySelector<HTMLButtonElement>('button[aria-label="save game"]')?.click();
  await ns.sleep(1000);
  finish(`done: $${ns.format.number(casinoWinnings())} won this install`, true);
}

/** Travel to Aevum, walk into the casino, open the blackjack table. */
async function enterTable(ns: NS, doc: Document, say: (m: string) => void): Promise<boolean> {
  const sing = ns.singularity;
  const closed = dismissPopups(doc);
  if (closed) say(`closed ${closed} popup(s)`);
  const city = ns.getPlayer().city;
  if (city !== "Aevum") {
    say(`travelling ${city} → Aevum`);
    if (!sing.travelToCity("Aevum")) return say("travel failed (not enough money?)"), false;
  }
  say("entering Iker Molina Casino");
  if (!sing.goToLocation("Iker Molina Casino")) return say("goToLocation failed"), false;
  await ns.sleep(300);
  dismissPopups(doc);
  const tableBtn = await waitFor(ns, () => button(doc, (t) => t.startsWith("Play blackjack")), 5000);
  if (!tableBtn) return say("no 'Play blackjack' button on screen"), false;
  tableBtn.click();
  const ok = !!(await waitFor(ns, () => button(doc, (t) => t === "Start"), 3000));
  if (!ok) say("blackjack table didn't open (no 'Start' button)");
  return ok;
}

// ---------- table ----------

/**
 * Play one hand. Returns the outcome, "retry" if no hand got going (nothing was bet, so
 * it is safe to just try again), or null if the table vanished mid-hand.
 */
/** Why the last playHand() returned "retry" (for the progress log). */
let retryReason = "";
const retry = (why: string): "retry" => ((retryReason = why), "retry");

async function playHand(ns: NS, doc: Document, bet: number): Promise<Outcome | "retry" | null> {
  const input = doc.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) return retry("no bet input on screen");
  // set it twice: React ignores an unchanged value, and a *changed* valid bet is what
  // clears the previous hand's result text (so it can't be misread as this hand's result).
  // The first value must be valid too: bet+1 at the $100m max would be rejected and snap
  // back to $100m, making the second write look unchanged → Start stays disabled.
  setReactInput(doc, input, String(bet > 1 ? bet - 1 : bet + 1));
  setReactInput(doc, input, String(bet));
  await ns.sleep(50);
  if (readResult(doc)) return retry("previous result still shown after changing the bet");
  dismissPopups(doc);
  const start = await waitFor(ns, () => button(doc, (t) => t === "Start"), 3000);
  if (!start) return retry("no Start button");
  if (start.disabled) return retry("Start is disabled (bet rejected as invalid)");
  pressTrusted(start);

  for (let i = 0; i < 20; i++) {
    const result = await waitFor(ns, () => readResult(doc) ?? (button(doc, (t) => t === "Hit") ? "turn" : null), 3000);
    // first wait: nothing at all means the game refused to deal (e.g. "not enough money")
    if (!result) return i === 0 ? retry("pressed Start but no cards were dealt") : null;
    if (result !== "turn") return result;
    const player = handCount(doc, "Player");
    const up = dealerUpcard(doc);
    if (!player || up === null) return null;
    const act = shouldHit(player, up) ? "Hit" : "Stay";
    const btn = button(doc, (t) => t === act);
    if (!btn) return null;
    pressTrusted(btn);
    await ns.sleep(60);
  }
  return null;
}

/** Basic strategy for a hit/stand-only game. */
export function shouldHit(hand: { best: number; soft: boolean }, dealer: number): boolean {
  const { best, soft } = hand;
  if (soft) {
    if (best <= 17) return true;
    if (best === 18) return dealer >= 9; // 9, 10, A
    return false;
  }
  if (best <= 11) return true;
  if (best === 12) return !(dealer >= 4 && dealer <= 6);
  if (best <= 16) return dealer >= 7;
  return false;
}

function readResult(doc: Document): Outcome | null {
  for (const p of doc.querySelectorAll("p")) {
    const t = p.textContent ?? "";
    if (t.startsWith("You won!") || t.startsWith("You Won! Blackjack!")) return "win";
    if (t.startsWith("You lost!")) return "loss";
    if (t.startsWith("Push! (Tie)")) return "push";
  }
  return null;
}

/** The hand's container: the element whose first label reads "Player"/"Dealer". */
function handBox(doc: Document, who: "Player" | "Dealer"): Element | null {
  for (const p of doc.querySelectorAll("p")) if (p.textContent === who) return p.parentElement;
  return null;
}

function handCount(doc: Document, who: "Player" | "Dealer"): { best: number; soft: boolean } | null {
  const box = handBox(doc, who);
  const countEl = box && [...box.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Count:"));
  if (!countEl) return null;
  const values = [...countEl.querySelectorAll("span")].map((s) => Number(s.textContent)).filter((n) => n > 0);
  if (!values.length) return null;
  const ok = values.filter((v) => v <= 21);
  const best = ok.length ? Math.max(...ok) : Math.min(...values);
  // two counts (e.g. "7 or 17") with the higher one still in play = a soft hand
  return { best, soft: ok.length > 1 && best === Math.max(...values) };
}

function dealerUpcard(doc: Document): number | null {
  const box = handBox(doc, "Dealer");
  if (!box) return null;
  for (const s of box.querySelectorAll("span")) {
    const v = (s.textContent ?? "").trim();
    if (v === "A") return 11;
    if (["J", "Q", "K"].includes(v)) return 10;
    if (/^(10|[2-9])$/.test(v)) return Number(v);
  }
  return null;
}

// ---------- DOM helpers ----------

/**
 * Press a button whose handler rejects scripted clicks. Blackjack's Start/Hit/Stay do
 * `if (!event.isTrusted) return;`, and a DOM .click() is never trusted, so we call the
 * React onClick React stored on the element (under "__reactProps$<id>") with an event
 * that says it is. Falls back to .click() for ordinary buttons.
 */
function pressTrusted(el: HTMLElement): void {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const props = key ? (el as unknown as Record<string, { onClick?: (e: unknown) => void }>)[key] : undefined;
  if (!props?.onClick) {
    el.click();
    return;
  }
  props.onClick({
    isTrusted: true,
    type: "click",
    target: el,
    currentTarget: el,
    button: 0,
    preventDefault() {},
    stopPropagation() {},
    persist() {},
  });
}

/**
 * Close the game's popups (MUI modals: "You do not have enough money.", info dialogs…).
 * Their close button holds MUI's CloseIcon, which renders with data-testid="CloseIcon".
 * Returns how many were closed.
 */
function dismissPopups(doc: Document): number {
  let n = 0;
  for (const modal of doc.querySelectorAll(".MuiModal-root")) {
    const close = modal.querySelector('[data-testid="CloseIcon"]')?.closest("button");
    if (close) {
      close.click();
      n++;
    }
  }
  return n;
}

function button(doc: Document, match: (text: string) => boolean): HTMLButtonElement | null {
  for (const b of doc.querySelectorAll("button")) if (match((b.textContent ?? "").trim())) return b;
  return null;
}

/** Set a React-controlled input's value so React's onChange fires. */
function setReactInput(doc: Document, input: HTMLInputElement, value: string): void {
  const proto = doc.defaultView!.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitFor<T>(ns: NS, probe: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = probe();
    if (v) return v;
    await ns.sleep(25);
  }
  return null;
}
