// Bitburner single-player game module: buys the game's TOR router and DarkscapeNavigator.exe
// through the in-game Singularity API. No real network or software purchase is involved.
import type { NS, ProgramName } from "@ns";
import { call } from "../../lib/call.js";
import { paths } from "./lib.js";

const PROGRAM: ProgramName = "DarkscapeNavigator.exe";

function log(ns: NS, message: string): void {
  ns.print("[dnet-setup] " + message);
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const p = paths(ns);

  let tor = false;
  try {
    tor = (await call<boolean>(ns, "hasTorRouter")) === true;
  } catch (e) {
    log(ns, "could not check TOR router: " + String(e));
  }

  if (!tor) {
    log(ns, "TOR router missing; attempting purchase");
    try {
      await call<boolean>(ns, "singularity.purchaseTor");
      tor = (await call<boolean>(ns, "hasTorRouter")) === true;
      if (tor) ns.tprint("Darknet setup: purchased TOR router.");
      else log(ns, "TOR purchase failed; need $200k and Singularity access.");
    } catch (e) {
      log(ns, "TOR purchase error: " + String(e));
      ns.tprint("Darknet setup: cannot buy TOR. Requires $200k and SF4 Singularity access.");
    }
  }

  if (!tor) return;

  let hasProgram = false;
  try {
    hasProgram = ns.fileExists(PROGRAM, "home");
  } catch {
    hasProgram = false;
  }

  if (!hasProgram) {
    log(ns, "DarkscapeNavigator.exe missing; attempting purchase");
    try {
      await call<boolean>(ns, "singularity.purchaseProgram", PROGRAM);
      hasProgram = ns.fileExists(PROGRAM, "home");
      if (hasProgram) ns.tprint("Darknet setup: purchased DarkscapeNavigator.exe.");
      else log(ns, "DarkscapeNavigator purchase failed; need ~$30-50m and Singularity access.");
    } catch (e) {
      log(ns, "DarkscapeNavigator purchase error: " + String(e));
      ns.tprint("Darknet setup: cannot buy DarkscapeNavigator.exe. Requires money and SF4 Singularity access.");
    }
  }

  if (!hasProgram) return;

  let existing = "";
  try {
    existing = ns.read(p.charisma).trim();
  } catch {}

  try {
    const player = await call<{ skills: { charisma: number } }>(ns, "getPlayer");
    if (!player) {
      log(ns, "could not read charisma");
      return;
    }
    const text = String(player.skills.charisma);
    if (existing === text) {
      log(ns, "charisma unchanged: " + text);
    } else {
      ns.write(p.charisma, text, "w");
      log(ns, "wrote charisma " + text + " to " + p.charisma);
      ns.tprint("Darknet setup: charisma updated to " + text + ".");
    }
  } catch (e) {
    log(ns, "could not write charisma: " + String(e));
  }
}
