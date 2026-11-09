// Bitburner single-player game module: solves the game's Labyrinth minigame through
// `ns.dnet` and loots its in-game cache. No real systems are accessed.
import type { NS } from "@ns";
import { authenticateRetry, loadStore, paths, pushSnapshotToHome, recordReward, saveStore } from "./lib.js";

interface Direction {
  name: string;
  dx: number;
  dy: number;
  opposite: string;
}

type Open = Record<string, boolean>;

interface Frame {
  x: number;
  y: number;
  open: Open;
  entered: string | null;
  unknown: number;
}

type MoveResult =
  | { kind: "solved"; password: string }
  | { kind: "moved"; x: number; y: number; open: Open | null; reason: string }
  | { kind: "charisma"; reason: string }
  | { kind: "disconnected"; reason: string }
  | { kind: "wall"; reason: string }
  | { kind: "unknown"; code: number | null; reason: string };

type Report =
  | { ok: true; x: number; y: number; open: Open }
  | { ok: false; reason: string };

const DIRECTIONS: Direction[] = [
  { name: "north", dx: 0, dy: -2, opposite: "south" },
  { name: "east", dx: 2, dy: 0, opposite: "west" },
  { name: "south", dx: 0, dy: 2, opposite: "north" },
  { name: "west", dx: -2, dy: 0, opposite: "east" },
];

const BY_NAME = new Map(DIRECTIONS.map((direction) => [direction.name, direction]));

function log(ns: NS, message: string): void {
  ns.print("[lab " + ns.getHostname() + "] " + message);
}

function cellKey(x: number, y: number): string {
  return x + "," + y;
}

function readCharisma(ns: NS): number {
  try {
    const raw = ns.read(paths(ns).charisma).trim();
    if (!raw) return Infinity;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Infinity;
  } catch {
    return Infinity;
  }
}

async function readReport(ns: NS): Promise<Report> {
  let result: any;
  try {
    result = await ns.dnet.labreport();
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
  if (!result || result.success !== true) {
    return { ok: false, reason: result && result.message ? result.message : "labreport failed" };
  }
  if (!Array.isArray(result.coords) || result.coords.length < 2) {
    return { ok: false, reason: "labreport missing coords" };
  }
  const x = Number(result.coords[0]);
  const y = Number(result.coords[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, reason: "labreport invalid coords" };
  }
  return {
    ok: true,
    x,
    y,
    open: {
      north: result.north === true,
      east: result.east === true,
      south: result.south === true,
      west: result.west === true,
    },
  };
}

function parseSurroundings(text: unknown): Open | null {
  if (typeof text !== "string") return null;
  const lines = text.replaceAll("\r", "").split("\n");
  if (lines.length !== 3 || lines.some((line) => line.length < 3)) return null;
  return {
    north: lines[0][1] === " ",
    east: lines[1][2] === " ",
    south: lines[2][1] === " ",
    west: lines[1][0] === " ",
  };
}

function parseMoveResult(result: { message?: string; code?: number; data?: unknown } | null): MoveResult {
  const message = result && typeof result.message === "string" ? result.message : "";
  const code = result ? Number(result.code) : null;
  if (code === 451) return { kind: "charisma", reason: message };
  if (code === 351) return { kind: "disconnected", reason: message };
  if (/cannot go that way/i.test(message) || /still at -?\d+,-?\d+/i.test(message)) {
    return { kind: "wall", reason: message };
  }
  const moved = message.match(/moved to (-?\d+),(-?\d+)/i);
  if (moved) {
    return {
      kind: "moved",
      x: Number(moved[1]),
      y: Number(moved[2]),
      open: parseSurroundings(result?.data),
      reason: message,
    };
  }
  return { kind: "unknown", code, reason: message || "unknown move result" };
}

async function step(ns: NS, host: string, direction: string): Promise<MoveResult> {
  const response = await authenticateRetry(ns, host, direction);
  if (response.success) {
    return {
      kind: "solved",
      password: response.result && typeof response.result.data === "string" ? response.result.data : "",
    };
  }
  return parseMoveResult(response.result);
}

function findFrameIndex(stack: Frame[], x: number, y: number): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].x === x && stack[i].y === y) return i;
  }
  return -1;
}

async function syncKnown(ns: NS, stack: Frame[]): Promise<{ ok: true; frame: Frame } | { ok: false; reason: string }> {
  const report = await readReport(ns);
  if (!report.ok) return { ok: false, reason: report.reason };
  const index = findFrameIndex(stack, report.x, report.y);
  if (index < 0) return { ok: false, reason: "maze position lost" };
  stack.length = index + 1;
  const frame = stack[index];
  frame.x = report.x;
  frame.y = report.y;
  frame.open = report.open;
  return { ok: true, frame };
}

async function syncOrPush(
  ns: NS,
  stack: Frame[],
  expectedX: number,
  expectedY: number,
  entered: string,
): Promise<{ ok: true; moved: boolean } | { ok: false; reason: string }> {
  const report = await readReport(ns);
  if (!report.ok) return { ok: false, reason: report.reason };
  if (report.x === expectedX && report.y === expectedY) {
    stack.push({
      x: expectedX,
      y: expectedY,
      open: report.open,
      entered,
      unknown: 0,
    });
    return { ok: true, moved: true };
  }
  const index = findFrameIndex(stack, report.x, report.y);
  if (index < 0) return { ok: false, reason: "maze position lost" };
  stack.length = index + 1;
  const frame = stack[index];
  frame.x = report.x;
  frame.y = report.y;
  frame.open = report.open;
  return { ok: true, moved: false };
}

function chooseDirection(frame: Frame, visited: Set<string>): Direction | null {
  for (const direction of DIRECTIONS) {
    if (!frame.open || !frame.open[direction.name]) continue;
    if (visited.has(cellKey(frame.x + direction.dx, frame.y + direction.dy))) continue;
    return direction;
  }
  return null;
}

async function solve(ns: NS, labHost: string): Promise<{ solved: boolean; password?: string; moves?: number; reason?: string }> {
  const start = await readReport(ns);
  if (!start.ok) return { solved: false, reason: start.reason };

  const stack: Frame[] = [{ x: start.x, y: start.y, open: start.open, entered: null, unknown: 0 }];
  const visited = new Set([cellKey(start.x, start.y)]);
  let moves = 0;

  while (stack.length) {
    const frame = stack[stack.length - 1];
    const direction = chooseDirection(frame, visited);

    if (!direction) {
      if (!frame.entered) {
        return { solved: false, reason: "no unvisited path from start" };
      }
      const back = BY_NAME.get(frame.entered)!.opposite;
      const result = await step(ns, labHost, back);
      if (result.kind === "solved") {
        return { solved: true, password: result.password, moves: moves + 1 };
      }
      if (result.kind === "charisma") {
        return { solved: false, reason: "not enough charisma: " + result.reason };
      }
      if (result.kind === "disconnected") {
        return { solved: false, reason: "not directly connected: " + result.reason };
      }
      if (result.kind === "moved") {
        const parent = stack[stack.length - 2];
        if (!parent) return { solved: false, reason: "backtrack without parent" };
        if (result.x !== parent.x || result.y !== parent.y) {
          const sync = await syncKnown(ns, stack);
          if (!sync.ok) return { solved: false, reason: sync.reason };
          continue;
        }
        stack.pop();
        parent.open = result.open || parent.open;
        parent.unknown = 0;
        moves++;
        continue;
      }
      if (result.kind === "wall") {
        const sync = await syncKnown(ns, stack);
        if (!sync.ok) return { solved: false, reason: sync.reason };
        if (sync.frame === frame) {
          return { solved: false, reason: "backtrack blocked at " + frame.x + "," + frame.y };
        }
        moves++;
        continue;
      }
      const sync = await syncKnown(ns, stack);
      if (!sync.ok) return { solved: false, reason: sync.reason };
      sync.frame.unknown = (sync.frame.unknown || 0) + 1;
      if (sync.frame.unknown > 3) return { solved: false, reason: "too many backtrack timeouts" };
      continue;
    }

    const expectedX = frame.x + direction.dx;
    const expectedY = frame.y + direction.dy;
    const result = await step(ns, labHost, direction.name);

    if (result.kind === "solved") {
      return { solved: true, password: result.password, moves: moves + 1 };
    }
    if (result.kind === "charisma") {
      return { solved: false, reason: "not enough charisma: " + result.reason };
    }
    if (result.kind === "disconnected") {
      return { solved: false, reason: "not directly connected: " + result.reason };
    }
    if (result.kind === "wall") {
      frame.open[direction.name] = false;
      continue;
    }
    if (result.kind === "moved") {
      if (result.x === expectedX && result.y === expectedY) {
        let open = result.open;
        if (!open) {
          const sync = await syncOrPush(ns, stack, expectedX, expectedY, direction.name);
          if (!sync.ok) return { solved: false, reason: sync.reason };
          if (sync.moved) {
            visited.add(cellKey(expectedX, expectedY));
            moves++;
          }
          continue;
        }
        visited.add(cellKey(expectedX, expectedY));
        stack.push({
          x: expectedX,
          y: expectedY,
          open,
          entered: direction.name,
          unknown: 0,
        });
        moves++;
        continue;
      }
      const sync = await syncOrPush(ns, stack, expectedX, expectedY, direction.name);
      if (!sync.ok) return { solved: false, reason: sync.reason };
      if (sync.moved) {
        visited.add(cellKey(expectedX, expectedY));
        moves++;
      }
      continue;
    }

    const sync = await syncOrPush(ns, stack, expectedX, expectedY, direction.name);
    if (!sync.ok) return { solved: false, reason: sync.reason };
    if (sync.moved) {
      visited.add(cellKey(expectedX, expectedY));
      moves++;
      continue;
    }
    const current = stack[stack.length - 1];
    current.unknown = (current.unknown || 0) + 1;
    if (current.unknown > 3) return { solved: false, reason: "too many move timeouts" };
  }

  return { solved: false, reason: "maze exhausted" };
}

function loot(ns: NS): void {
  const me = ns.getHostname();
  let files: string[] = [];
  try {
    files = ns.ls(me, ".cache");
  } catch (e) {
    log(ns, "cannot list caches: " + String(e));
    return;
  }
  if (!files.length) {
    log(ns, "no lab cache found");
    return;
  }
  for (const file of files) {
    if (typeof file !== "string") continue;
    try {
      const result = ns.dnet.openCache(file, false);
      if (result && result.success) {
        const message = result.message || "reward";
        recordReward(ns, ns.getHostname(), file, result);
        log(ns, "opened " + file + ": " + message);
        ns.tprint("Darknet lab: " + message);
      } else {
        log(ns, "cache failed " + file + ": " + (result && result.message ? result.message : "unknown"));
      }
    } catch (e) {
      log(ns, "cache error " + file + ": " + String(e));
    }
  }
}

async function startLooter(ns: NS, labHost: string): Promise<boolean> {
  const p = paths(ns);
  try {
    if (!ns.scp([p.lab, p.lib], labHost)) {
      log(ns, "could not copy looter to " + labHost);
      return false;
    }
  } catch (e) {
    log(ns, "looter scp failed: " + String(e));
    return false;
  }
  try {
    const pid = ns.exec(p.lab, labHost, 1, "loot");
    if (pid === 0) {
      log(ns, "could not start looter on " + labHost);
      return false;
    }
    log(ns, "started looter on " + labHost);
    return true;
  } catch (e) {
    log(ns, "looter exec failed: " + String(e));
    return false;
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  if (ns.args[0] === "loot") {
    loot(ns);
    return;
  }

  const labHost = String(ns.args[0] || "");
  const required = Number(ns.args[1]);
  if (!labHost) {
    log(ns, "missing lab host");
    return;
  }

  const charisma = readCharisma(ns);
  if (Number.isFinite(required) && required > 0 && charisma < required) {
    log(ns, "skip " + labHost + ": charisma " + required + " required, have " + charisma);
    return;
  }

  const result = await solve(ns, labHost);
  if (!result.solved) {
    log(ns, "failed " + labHost + ": " + result.reason);
    return;
  }

  log(ns, "solved " + labHost + " in " + result.moves + " moves");
  const store = loadStore(ns);
  if (result.password) {
    store[labHost] = result.password;
    saveStore(ns, store);
    pushSnapshotToHome(ns, store);
  }

  await startLooter(ns, labHost);
}
