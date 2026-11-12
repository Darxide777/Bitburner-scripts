// Source-level checks for two mistakes that typecheck cannot see (see AGENTS.md, "Pitfalls").
// They read src/*.ts as text, so they need no build and no game.
//
//   1. Status files hold ONE JSON object and are read with readJson. Appending lines to one
//      makes every readJson of it return its fallback.
//   2. ns.isRunning(script, host) / ns.kill(script, host) only match a process started with
//      NO arguments. For a script that is started with arguments they silently do nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** Source with comments blanked out (same length, same line numbers). */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

const FILES = walk(SRC).map((path) => ({ file: relative(ROOT, path), text: stripComments(readFileSync(path, "utf8")) }));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Every call `name(` in `text`, with its top-level arguments as trimmed source strings. */
function calls(text, name) {
  const out = [];
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\./g, "\\.")}\\s*(?:<[^()]*?>)?\\(`, "g");
  for (let m; (m = re.exec(text)); ) {
    const args = [];
    let depth = 0;
    let quote = "";
    let cur = "";
    let i = re.lastIndex;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        cur += ch;
        if (ch === "\\") cur += text[++i] ?? "";
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push({ args, line: lineOf(text, m.index) });
  }
  return out;
}

// ---------- 1. status files ----------

test("a file read with readJson is never written by an append helper", () => {
  const readers = new Map(); // file expression → where it is read
  const appenders = [];
  for (const { file, text } of FILES) {
    if (file === join("src", "lib", "io.ts")) continue;
    for (const c of calls(text, "readJson")) if (c.args[1]) readers.set(c.args[1], `${file}:${c.line}`);
    for (const helper of ["appendJsonl", "appendLines", "appendLine", "appendStatus"])
      for (const c of calls(text, helper)) if (c.args[1]) appenders.push({ target: c.args[1], where: `${file}:${c.line}`, helper });
  }
  const bad = appenders.filter((a) => readers.has(a.target));
  assert.deepEqual(
    bad.map((a) => `${a.where} ${a.helper}(${a.target}) but it is read with readJson at ${readers.get(a.target)}`),
    [],
    "status files hold one JSON object: write them with writeJson, and log history to a separate file",
  );
});

// ---------- 2. isRunning / kill without arguments ----------

/**
 * Calls that are allowed although the rule below matches them. Each entry must still match
 * a real call: when the code is fixed, delete the entry (the test fails until you do).
 *   bug:      a known bug with an open item in the README to-do list
 *   intended: checked by hand; say why
 */
const ALLOWED = [
  { file: "src/daemon.ts", call: 'ns.isRunning("tasks/install.js", "home")', bug: "README to-do item 1" },
  { file: "src/user/dnet/roamer.ts", call: "ns.isRunning(p.lab, me)", bug: "README to-do item 6" },
  { file: "src/user/dnet/roamer.ts", call: "ns.isRunning(p.roamer, host)", intended: 'also matches a hand-started roamer; the "auto" form is checked beside it' },
  { file: "src/user/dnet/manager.ts", call: 'ns.isRunning(p.roamer, "darkweb")', intended: 'also matches a hand-started roamer; the "auto" form is checked beside it' },
];

test("isRunning/kill by name always pass the arguments the script was started with", () => {
  // scripts that are started with arguments somewhere in the code base
  const withArgs = new Set();
  for (const { text } of FILES) {
    // ns.exec(script, host, threadsOrOptions, ...args)
    for (const c of calls(text, "ns.exec")) if (c.args.length > 3) withArgs.add(c.args[0]);
    // runTask/spawnTask always pass the result file as the first argument
    for (const fn of ["runTask", "spawnTask"]) for (const c of calls(text, fn)) if (c.args[1]) withArgs.add(c.args[1]);
  }
  const isTask = (expr) => /^["'`]tasks\//.test(expr);

  const found = [];
  for (const { file, text } of FILES)
    for (const fn of ["ns.isRunning", "ns.kill"])
      for (const c of calls(text, fn)) {
        if (c.args.length !== 2) continue; // a pid (1 argument) or name + host + args (3+) is fine
        if (!withArgs.has(c.args[0]) && !isTask(c.args[0])) continue;
        found.push({ file: file.split("\\").join("/"), line: c.line, call: `${fn}(${c.args.join(", ")})` });
      }

  const allowed = (f) => ALLOWED.some((a) => a.file === f.file && a.call === f.call);
  assert.deepEqual(
    found.filter((f) => !allowed(f)).map((f) => `${f.file}:${f.line} ${f.call}`),
    [],
    "this script is started with arguments, so name + host never matches it: pass the same arguments, use the pid, or search ns.ps(host)",
  );
  const stale = ALLOWED.filter((a) => !found.some((f) => f.file === a.file && f.call === a.call));
  assert.deepEqual(
    stale.map((a) => `${a.file} ${a.call}`),
    [],
    "these ALLOWED entries no longer match any call: delete them from test/conventions.test.mjs",
  );
});
