// Bitburner Remote API sync server (written from scratch for this repo).
//
// The game is the WebSocket *client*: in-game, go to Options → Remote API, set the
// port (default here: 12525) and press Connect. This server then:
//   1. runs `tsc --watch` (unless --no-watch-build) so src/**/*.ts → dist/**/*.js
//   2. pushes every file in dist/ to the game's "home" server on connect, and any
//      changed file after that; deletes files removed from dist/
//   3. refreshes types/NetscriptDefinitions.d.ts from the running game, so the
//      types always match the game version you actually play
//   4. every PULL_INTERVAL ms, pulls the automation's telemetry files (data/*.txt
//      on home) back into ./logs/ so they can be analyzed outside the game
//
// Protocol: JSON-RPC 2.0 over WebSocket (methods pushFile, getFile, deleteFile,
// getFileNames, getDefinitionFile, ...), as implemented in the game's
// src/RemoteFileAPI/MessageHandlers.ts.
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { exportAll } from "./fix-defs.mjs";

const args = process.argv.slice(2);
const PORT = Number(argValue("--port") ?? process.env.BB_PORT ?? 12525);
const DIST = "dist";
const LOGS = "logs";
const PULL_INTERVAL = Number(argValue("--pull-ms") ?? 60_000);
const WATCH_BUILD = !args.includes("--no-watch-build");

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const log = (...m) => console.log(`[sync ${new Date().toLocaleTimeString()}]`, ...m);

// ---------- build ----------
if (WATCH_BUILD) {
  const tsc = spawn("npx", ["tsc", "-p", ".", "--watch", "--preserveWatchOutput"], { stdio: "inherit" });
  process.on("exit", () => tsc.kill());
  process.on("SIGINT", () => process.exit(0));
}

// ---------- RPC client over the game's socket ----------
let socket = null;
let nextId = 1;
const pending = new Map();

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error("game not connected"));
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 15_000);
  });
}

// ---------- file helpers ----------
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const gamePath = (localPath) => relative(DIST, localPath).split(sep).join("/");
const pushable = (p) => /\.(js|txt|json)$/.test(p);

const lastPushed = new Map(); // gamePath -> content
async function push(localPath) {
  const filename = gamePath(localPath);
  let content;
  try {
    content = readFileSync(localPath, "utf8");
  } catch {
    return; // vanished between event and read
  }
  if (lastPushed.get(filename) === content) return;
  try {
    await rpc("pushFile", { server: "home", filename, content });
    lastPushed.set(filename, content);
    if (!manifest.has(filename)) {
      manifest.add(filename);
      saveManifest();
    }
    log("pushed", filename);
  } catch (e) {
    log("push failed", filename, e.message);
  }
}

// Files this tool has ever pushed. Only these may be deleted in-game, so scripts
// you wrote by hand in the game are never touched.
const MANIFEST = ".sync-manifest.json";
const manifest = new Set(existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : []);
const saveManifest = () => writeFileSync(MANIFEST, JSON.stringify([...manifest].sort(), null, 1));

async function pushAll() {
  const files = walk(DIST).filter(pushable);
  for (const f of files) await push(f);
  // delete game-side files we pushed in the past but no longer build
  const ours = new Set(files.map(gamePath));
  try {
    const remote = new Set((await rpc("getFileNames", { server: "home" })).map((f) => f.replace(/^\//, "")));
    for (const f of [...manifest]) {
      if (ours.has(f)) continue;
      if (remote.has(f)) {
        await rpc("deleteFile", { server: "home", filename: f });
        log("deleted stale", f);
      }
      manifest.delete(f);
    }
  } catch (e) {
    log("stale-file sweep failed:", e.message);
  }
  saveManifest();
}

async function refreshDefinitions() {
  try {
    const defs = await rpc("getDefinitionFile");
    if (typeof defs === "string" && defs.length > 1000) {
      const out = exportAll(defs);
      const path = "types/NetscriptDefinitions.d.ts";
      if (!existsSync(path) || readFileSync(path, "utf8") !== out) {
        writeFileSync(path, out);
        log("updated types/NetscriptDefinitions.d.ts from the game");
      }
    }
  } catch (e) {
    log("definition refresh failed:", e.message);
  }
}

async function pullLogs() {
  try {
    const names = await rpc("getFileNames", { server: "home" });
    const wanted = names.map((n) => n.replace(/^\//, "")).filter((n) => n.startsWith("data/") && n.endsWith(".txt"));
    for (const filename of wanted) {
      const content = await rpc("getFile", { server: "home", filename });
      const dest = join(LOGS, filename.slice("data/".length));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    if (wanted.length) log(`pulled ${wanted.length} telemetry file(s) into ${LOGS}/`);
  } catch (e) {
    log("log pull failed:", e.message);
  }
}

// ---------- server ----------
const wss = new WebSocketServer({ port: PORT });
log(`listening on ws://localhost:${PORT} — in game: Options → Remote API → port ${PORT} → Connect`);

let pullTimer = null;
wss.on("connection", async (ws) => {
  if (socket) socket.close();
  socket = ws;
  log("game connected");
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error}`));
    else p.resolve(msg.result);
  });
  ws.on("close", () => {
    if (socket === ws) socket = null;
    clearInterval(pullTimer);
    lastPushed.clear();
    log("game disconnected");
  });
  await refreshDefinitions();
  await pushAll();
  await pullLogs();
  clearInterval(pullTimer);
  pullTimer = setInterval(pullLogs, PULL_INTERVAL);
});

// ---------- watch dist ----------
mkdirSync(DIST, { recursive: true });
const debounce = new Map();
watch(DIST, { recursive: true }, (_event, name) => {
  if (!name) return;
  const local = join(DIST, name);
  if (!pushable(local)) return;
  clearTimeout(debounce.get(local));
  debounce.set(
    local,
    setTimeout(async () => {
      if (!socket) return;
      if (existsSync(local)) await push(local);
      else {
        try {
          await rpc("deleteFile", { server: "home", filename: gamePath(local) });
          lastPushed.delete(gamePath(local));
          manifest.delete(gamePath(local));
          saveManifest();
          log("deleted", gamePath(local));
        } catch {}
      }
    }, 150),
  );
});
