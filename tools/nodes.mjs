// Node-to-node comparison from the telemetry pulled into ./logs/.
//
//   node tools/nodes.mjs
//
// Cleared BitNodes (logs/nodes.txt): length, route, installs, and when each milestone happened;
// then the current node's milestones so far (logs/milestones.txt). Backfilled milestones
// (already true when tracking started) are marked "~" and aren't real times.
import { existsSync, readFileSync } from "node:fs";

const jsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const h = (ms) => (ms == null ? "?" : ms < 3600e3 ? `${(ms / 60e3).toFixed(0)}m` : `${(ms / 3600e3).toFixed(1)}h`);

const nodes = jsonl("logs/nodes.txt");
const ms = jsonl("logs/milestones.txt");
if (!nodes.length) console.log("no cleared BitNode recorded yet (logs/nodes.txt)\n");
for (const n of nodes) {
  console.log(`BN${n.node ?? "?"} cleared ${new Date(n.t).toISOString().slice(0, 16)}: ${h(n.durationMs)}, ${n.installs} installs, route ${n.route ?? "?"}`);
  for (const [name, at] of Object.entries(n.milestones ?? {}).sort((a, b) => a[1] - b[1])) console.log(`  ${h(at).padStart(6)}  ${name}`);
  console.log();
}
const lastClear = nodes.length ? nodes[nodes.length - 1].t : 0;
const cur = ms.filter((m) => m.t > lastClear);
if (cur.length) {
  console.log("current node so far:");
  for (const m of cur.sort((a, b) => a.sinceNodeMs - b.sinceNodeMs))
    console.log(`  ${(m.backfilled ? "~" : "") + h(m.sinceNodeMs).padStart(6)}  ${m.name}  (after ${m.installs} installs)`);
}
