// Run-to-run comparison from the telemetry pulled into ./logs/.
//
//   node tools/runs.mjs [count]
//
// Newer runs include earned/spent, XP, hack level, aug value, and a `vsPrev`
// percentage comparison written by daemon.js. Older runs still show duration and
// whatever fields they have; missing comparisons are calculated from the previous
// install record here.
import { existsSync, readFileSync } from "node:fs";

const jsonl = (f) =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];
const pick = (name) => (existsSync(`logs/archive/${name}.jsonl`) ? `logs/archive/${name}.jsonl` : `logs/${name}.txt`);

const compact = (n) => {
  if (n == null || !Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  const units = [
    [1e18, "Q"],
    [1e15, "q"],
    [1e12, "t"],
    [1e9, "b"],
    [1e6, "m"],
    [1e3, "k"],
  ];
  const [scale, suffix] = units.find(([s]) => a >= s) ?? [1, ""];
  return `${(n / scale).toFixed(2)}${suffix}`;
};
const money = (n) => (n == null || !Number.isFinite(n) ? "?" : `$${compact(n)}`);
const num = (n) => (n == null || !Number.isFinite(n) ? "?" : Math.round(n).toLocaleString("en-US"));
const pct = (n) => (n == null || !Number.isFinite(n) ? "?" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`);
const dur = (ms) =>
  ms == null || !Number.isFinite(ms) ? "?" : ms < 3600e3 ? `${(ms / 60e3).toFixed(1)}m` : `${(ms / 3600e3).toFixed(2)}h`;
const when = (t) => (t == null ? "?" : new Date(t).toISOString().slice(0, 16).replace("T", " "));
const rate = (total, ms) => (total != null && ms > 0 ? (total * 1000) / ms : null);
const valuePerHour = (value, ms) => (value != null && ms > 0 ? value / (ms / 3600e3) : null);
const sumEarned = (o) => {
  if (!o || typeof o !== "object") return null;
  if (typeof o.total === "number") return o.total;
  return Object.values(o).reduce((a, v) => a + (typeof v === "number" ? v : 0), 0);
};

const limit = Math.max(1, Number(process.argv[2]) || 12);
const runs = jsonl(pick("runs"));
if (!runs.length) {
  console.log("no runs recorded yet (logs/runs.txt)\n");
  process.exit(0);
}

const installs = runs.filter((r) => r.kind !== "node");
const shown = runs.slice(-limit);
const recent = installs.slice(-5);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const recentLine = recent.length
  ? `recent ${recent.length}: avg ${dur(avg(recent.map((r) => r.durationMs)))} · income ${money(
      avg(recent.map((r) => r.incomePerSec ?? rate(r.earnedTotal ?? sumEarned(r.earned), r.durationMs)).filter((x) => x != null)),
    )}/s · value ${money(avg(recent.map((r) => r.valueRate ?? valuePerHour(r.value, r.durationMs)).filter((x) => x != null)))}/h`
  : "";

console.log(`${runs.length} records (${installs.length} installs) · showing last ${shown.length}${recentLine ? `\n${recentLine}` : ""}\n`);

let prevInstall =
  shown.length > 0 ? ([...installs].reverse().find((r) => r.t < shown[0].t) ?? null) : null;
for (const r of shown) {
  const i = runs.indexOf(r);
  const prev = prevInstall;
  if (r.kind !== "node") prevInstall = r;

  const id = r.runIndex != null ? `#${r.runIndex}` : `#${i + 1}`;
  const nodeRun = r.nodeRun != null ? ` run ${r.nodeRun}` : "";
  const node = r.node != null ? `BN${r.node}` : "BN?";
  const reset = r.kind === "node" ? "  [node reset]" : "";
  const level = r.nodeLevel != null ? `.${r.nodeLevel}` : "";
  const gap = r.gapMs > 0 ? ` (${dur(r.trackedMs ?? r.durationMs - r.gapMs)} tracked, ${dur(r.gapMs)} untracked)` : "";
  const builds = r.builds?.length ? `  build ${r.builds.map((b) => String(b).slice(0, 7)).join("→")}` : "";
  console.log(`${id}  ${node}${level}${nodeRun}  ended ${when(r.t)}  ${dur(r.durationMs)}${gap}${reset}${builds}`);

  const earned = r.earnedTotal ?? sumEarned(r.earned);
  const income = r.incomePerSec ?? rate(earned, r.durationMs);
  const runSpent = r.spent;
  const installSpent = r.installSpent;
  const value = r.value;
  const valueRate = r.valueRate ?? valuePerHour(value, r.durationMs);
  const hackLevel = r.hackLevelEnd ?? r.endHackLevel;
  const levelStart = r.hackLevelStart;
  const levelGain = r.hackLevelGain ?? (hackLevel != null && levelStart != null ? Math.max(0, hackLevel - levelStart) : null);
  const xp = r.hackExpPerSec;
  const repGain = r.repGained ?? (r.repEnd != null && r.repStart != null ? Math.max(0, r.repEnd - r.repStart) : null);

  const bits = [];
  if (earned != null) bits.push(`earned ${money(earned)}`);
  if (income != null) bits.push(`income ${money(income)}/s`);
  if (runSpent != null) bits.push(`run spend ${money(runSpent)}`);
  if (installSpent != null) bits.push(`install ${money(installSpent)}`);
  if (xp != null) bits.push(`XP ${compact(xp)}/s`);
  if (bits.length) console.log(`  ${bits.join("   ")}`);

  const bits2 = [];
  if (hackLevel != null) bits2.push(`hack ${levelStart != null ? `${num(levelStart)}→` : ""}${num(hackLevel)}${levelGain != null ? ` (+${num(levelGain)})` : ""}`);
  if (r.augsBefore != null || r.augsAfter != null) {
    const nfg = r.nfg ? `, ${r.nfg} NFG` : "";
    bits2.push(`augs ${num(r.augsBefore)}→${num(r.augsAfter)}${nfg}`);
  }
  if (repGain != null) bits2.push(`rep +${compact(repGain)}${r.repPerSec != null ? ` (${compact(r.repPerSec)}/s)` : ""}`);
  if (value != null) bits2.push(`value ${money(value)}${valueRate != null ? ` (${money(valueRate)}/h)` : ""}`);
  if (bits2.length) console.log(`  ${bits2.join("   ")}`);

  // what the spending bought: RAM by kind (start → end) and hacknet purchases
  const gb = (x) => (x == null ? "?" : x >= 1024 ? `${compact(x / 1024)}TB` : `${Math.round(x)}GB`);
  const bits3 = [];
  if (r.ramEnd) {
    const kinds = [["home", "homeGB"], ["cloud", "cloudGB"], ["hacknet", "hnetGB"], ["rooted", "otherGB"]];
    const ramBits = kinds
      .filter(([, k]) => (r.ramEnd[k] ?? 0) > 0)
      .map(([name, k]) => `${name} ${r.ramStart ? `${gb(r.ramStart[k])}→` : ""}${gb(r.ramEnd[k])}`);
    if (ramBits.length) bits3.push(`RAM ${ramBits.join(", ")}`);
  }
  const counts = (o) => Object.entries(o ?? {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}× ${k}`).join(", ");
  if (counts(r.hashes)) bits3.push(`hashes: ${counts(r.hashes)}`);
  if (counts(r.hashProduction)) bits3.push(`hacknet bought: ${counts(r.hashProduction)}${r.hashRateEnd != null ? ` (${r.hashRateEnd.toFixed(2)} h/s)` : ""}`);
  for (const b of bits3) console.log(`  ${b}`);
  const e = r.earned ?? {};
  if (e.hacknet_expenses || e.servers)
    console.log(`  spent: servers ${money(-(e.servers ?? 0))}, hacknet ${money(-(e.hacknet_expenses ?? 0))} (hacknet returned ${money(e.hacknet ?? 0)})`);

  const vs = r.vsPrev ?? {
    durationPct: prev?.durationMs > 0 ? (r.durationMs - prev.durationMs) / prev.durationMs : null,
    earnedPct: prev && earned != null && prev.earnedTotal != null ? (earned - prev.earnedTotal) / prev.earnedTotal : null,
    incomePct:
      prev && income != null && (prev.incomePerSec ?? rate(prev.earnedTotal, prev.durationMs)) != null
        ? (income - (prev.incomePerSec ?? rate(prev.earnedTotal, prev.durationMs))) / (prev.incomePerSec ?? rate(prev.earnedTotal, prev.durationMs))
        : null,
    hackExpPct: prev && xp != null && prev.hackExpPerSec != null ? (xp - prev.hackExpPerSec) / prev.hackExpPerSec : null,
    valueRatePct:
      prev && valueRate != null && (prev.valueRate ?? valuePerHour(prev.value, prev.durationMs)) != null
        ? (valueRate - (prev.valueRate ?? valuePerHour(prev.value, prev.durationMs))) / (prev.valueRate ?? valuePerHour(prev.value, prev.durationMs))
        : null,
  };
  const deltas = [
    ["dur", vs.durationPct],
    ["earned", vs.earnedPct],
    ["income", vs.incomePct],
    ["XP", vs.hackExpPct],
    ["value/h", vs.valueRatePct],
  ].filter(([, v]) => v != null);
  console.log(
    deltas.length
      ? `  vs prev: ${deltas.map(([name, v]) => `${name} ${pct(v)}`).join(" · ")}`
      : "  vs prev: first comparable run",
  );
  console.log();
}
