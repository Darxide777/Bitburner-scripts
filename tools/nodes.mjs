// Node-to-node comparison from the telemetry pulled into ./logs/.
//
//   node tools/nodes.mjs
//
// Cleared BitNodes (logs/nodes.txt): length, route, installs, totals, and when each milestone happened;
// then the current node's milestones so far (logs/milestones.txt). Backfilled milestones
// (already true when tracking started) are marked "~" and aren't real times.
import { existsSync, readFileSync } from "node:fs";

const jsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
// the archive keeps everything; fall back to the in-game copies
const pick = (name) => (existsSync(`logs/archive/${name}.jsonl`) ? `logs/archive/${name}.jsonl` : `logs/${name}.txt`);
const h = (ms) => (ms == null ? "?" : ms < 3600e3 ? `${(ms / 60e3).toFixed(0)}m` : `${(ms / 3600e3).toFixed(1)}h`);
const money = (n) => {
  if (n == null || !Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  const [scale, suffix] = [
    [1e18, "Q"],
    [1e15, "q"],
    [1e12, "t"],
    [1e9, "b"],
    [1e6, "m"],
    [1e3, "k"],
  ].find(([s]) => a >= s) ?? [1, ""];
  return `$${(n / scale).toFixed(2)}${suffix}`;
};
const num = (n) => (n == null || !Number.isFinite(n) ? "?" : Math.round(n).toLocaleString("en-US"));

const nodes = jsonl(pick("nodes"));
const ms = jsonl(pick("milestones"));
if (!nodes.length) console.log("no cleared BitNode recorded yet (logs/nodes.txt)\n");
for (const n of nodes) {
  console.log(
    `BN${n.node ?? "?"} cleared ${new Date(n.t).toISOString().slice(0, 16)}: ${h(n.durationMs)}, ${n.installs} installs${
      n.avgRunMs != null ? ` (avg run ${h(n.avgRunMs)})` : ""
    }, route ${n.route ?? "?"}`,
  );
  if (n.earnedTotal != null || n.spent != null || n.hackExpGained != null || n.peakIncomePerSec != null)
    console.log(
      `  earned ${money(n.earnedTotal)}   spent ${money(n.spent)}   hack XP ${num(n.hackExpGained)}   peak ${money(n.peakIncomePerSec)}/s   peak rep ${num(n.peakRepPerSec)}/s   peak cash ${money(n.peakMoney)}`,
    );
  const sources = Object.entries(n.earned ?? {})
    .filter(([name, v]) => name !== "total" && typeof v === "number" && v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4);
  if (sources.length) console.log(`  from ${sources.map(([name, v]) => `${name} ${money(v)}`).join(", ")}`);
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
