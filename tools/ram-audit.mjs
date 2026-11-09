// Rough offline RAM audit: lists identifiers in a compiled script's import tree that
// collide with Netscript function names (the game's RAM calculator charges for any
// identifier — including property names — that matches an API function name).
// Overestimates slightly (counts every identifier in imported files, not just
// reachable ones). Usage: node tools/ram-audit.mjs dist/daemon.js [RamCostGenerator.ts]
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [entry, costFile] = process.argv.slice(2);
const src = readFileSync(costFile, "utf8");
const consts = Object.create(null); // no prototype: "toString" etc. must not look like API names
for (const m of src.matchAll(/^\s+(\w+): ([\d.]+),/gm)) consts[m[1]] ??= Number(m[2]);
const cost = Object.create(null);
for (const m of src.matchAll(/^\s+(\w+): (.+?),?\s*$/gm)) {
  const [, name, expr] = m;
  const num = expr.match(/^([\d.]+)/);
  const c = expr.match(/RamCostConstants\.(\w+)(?:\s*([*/])\s*([\d.]+))?/);
  let v = num ? Number(num[1]) : c ? consts[c[1]] : undefined;
  if (c && v !== undefined && c[2]) v = c[2] === "/" ? v / Number(c[3]) : v * Number(c[3]);
  if (v !== undefined && !(name in cost)) cost[name] = v;
}
const seen = new Set();
const hits = new Map();
(function visitFile(file) {
  if (seen.has(file) || !existsSync(file)) return;
  seen.add(file);
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  (function walk(n) {
    if (ts.isImportDeclaration(n)) visitFile(resolve(dirname(file), n.moduleSpecifier.text));
    // the game's walker skips non-computed object-literal keys and declaration names it never visits
    const isLiteralKey = n.parent && (ts.isPropertyAssignment(n.parent) || ts.isMethodDeclaration(n.parent)) && n.parent.name === n;
    if (ts.isIdentifier(n) && !isLiteralKey && (n.text in cost || n.text === "document" || n.text === "window") && !["ns", "main"].includes(n.text)) {
      const set = hits.get(n.text) ?? new Set();
      set.add(file.replace(process.cwd() + "/", ""));
      hits.set(n.text, set);
    }
    ts.forEachChild(n, walk);
  })(sf);
})(resolve(entry));
// the game charges the DOM cost (25 GB) for any reference named document or window
const DOM = 25;
for (const name of ["document", "window"]) {
  if (!cost[name]) cost[name] = DOM;
}
let total = 1.6;
for (const [k, files] of [...hits].sort((a, b) => cost[b[0]] - cost[a[0]])) {
  total += cost[k];
  console.log(`${cost[k].toFixed(2).padStart(6)}  ${k.padEnd(28)} ${[...files].join(", ")}`);
}
console.log(`~${total.toFixed(2)} GB (estimate, incl. 1.6 base)`);
