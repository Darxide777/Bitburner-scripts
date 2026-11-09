// Analyses the sleeve shock-recovery experiment from logs/sleeves.txt (pulled from the game).
//
//   node tools/sleeve-shock.mjs [file]   (default: logs/archive/sleeves.jsonl, else logs/sleeves.txt)
//
// Reports:
//   1. shock decay (points/hour) by task: recovery vs. everything else (passive)
//   2. shock jumps (resets at installs/BitNodes), which cap how long recovery keeps paying
//   3. rep effect: for factions worked by exactly one sleeve, observed rep/s ÷ the formula's
//      prediction (formulas ignore shock). If shock costs rep, that ratio tracks (1 − shock/100).
//   4. break-even: an hour of recovery removes `extra` shock points beyond passive decay and
//      costs an hour of output at (1 − S/100). It pays when the sleeve keeps the lower shock
//      for at least H* = (1 − S/100) · 100 / extra hours (i.e. until the next shock reset).
import { existsSync, readFileSync } from "node:fs";

// the local archive has the full history; logs/sleeves.txt only the in-game (capped) copy
const file = process.argv[2] ?? (existsSync("logs/archive/sleeves.jsonl") ? "logs/archive/sleeves.jsonl" : "logs/sleeves.txt");
const lines = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .sort((a, b) => a.t - b.t);
if (lines.length < 2) {
  console.log(`${file}: need at least 2 samples (one per minute), have ${lines.length}`);
  process.exit(0);
}
const hours = (lines[lines.length - 1].t - lines[0].t) / 3600e3;
console.log(`${lines.length} samples over ${hours.toFixed(1)} h\n`);

// ---- 1 + 2: decay by task, and resets ----
const kind = (task) => (task === "recovery" ? "recovery" : "other");
const decay = { recovery: { pts: 0, h: 0 }, other: { pts: 0, h: 0 } };
const resets = [];
for (let k = 1; k < lines.length; k++) {
  const [a, b] = [lines[k - 1], lines[k]];
  const dh = (b.t - a.t) / 3600e3;
  if (dh <= 0 || dh > 0.25) continue; // gaps (game closed, daemon down) would blur rates
  for (const s1 of b.sleeves) {
    const s0 = a.sleeves.find((s) => s.i === s1.i);
    if (!s0) continue;
    const d = s0.shock - s1.shock;
    if (d < -0.5) {
      resets.push({ t: b.t, i: s1.i, from: s0.shock, to: s1.shock });
      continue;
    }
    // count an interval only if the task was the same at both ends
    if (kind(s0.task) !== kind(s1.task)) continue;
    const bucket = decay[kind(s1.task)];
    bucket.pts += d;
    bucket.h += dh;
  }
}
const rate = (b) => (b.h > 0 ? b.pts / b.h : NaN);
const rRec = rate(decay.recovery);
const rPas = rate(decay.other);
console.log("1. shock decay (points/hour, per sleeve)");
console.log(`   recovering: ${fmt(rRec)}  (${decay.recovery.h.toFixed(1)} sleeve-hours observed)`);
console.log(`   otherwise : ${fmt(rPas)}  (${decay.other.h.toFixed(1)} sleeve-hours observed)`);
const extra = rRec - rPas;
console.log(`   recovery adds ${fmt(extra)} pts/h over passive${Number.isFinite(rPas) && rPas > 0 ? ` (×${fmt(rRec / rPas)})` : ""}\n`);

console.log("2. shock resets");
if (!resets.length) console.log("   none seen (shock never jumped up)\n");
else {
  const byT = new Map();
  for (const r of resets) byT.set(r.t, [...(byT.get(r.t) ?? []), r]);
  for (const [t, rs] of byT)
    console.log(`   ${new Date(t).toISOString()}: ${rs.length} sleeve(s), e.g. ${fmt(rs[0].from)} → ${fmt(rs[0].to)}`);
  console.log();
}

// ---- 3: rep vs shock ----
console.log("3. observed ÷ predicted rep (factions worked by one sleeve only)");
const pts = [];
for (const l of lines) {
  const by = new Map();
  for (const s of l.sleeves) if (s.faction) by.set(s.faction, [...(by.get(s.faction) ?? []), s]);
  for (const [f, ss] of by) {
    if (ss.length !== 1 || !(ss[0].predictedRep > 0)) continue;
    const obs = l.observedRep?.[f];
    if (!(obs > 0)) continue;
    pts.push({ shock: ss[0].shock, ratio: obs / ss[0].predictedRep });
  }
}
if (pts.length < 5) console.log(`   only ${pts.length} usable samples — needs sleeves on faction work (after the karma phase)\n`);
else {
  // compare: ratio itself vs ratio ÷ (1 − shock/100); the steadier one is the better model
  const r1 = pts.map((p) => p.ratio);
  const r2 = pts.map((p) => p.ratio / Math.max(0.01, 1 - p.shock / 100));
  const cv = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    return { m, cv: sd / m };
  };
  const [plain, scaled] = [cv(r1), cv(r2)];
  const lo = Math.min(...pts.map((p) => p.shock));
  const hi = Math.max(...pts.map((p) => p.shock));
  console.log(`   ${pts.length} samples, shock ${fmt(lo)}–${fmt(hi)}`);
  console.log(`   ratio            : mean ${fmt(plain.m)}, spread ${(plain.cv * 100).toFixed(0)}%`);
  console.log(`   ratio ÷ (1−S/100): mean ${fmt(scaled.m)}, spread ${(scaled.cv * 100).toFixed(0)}%`);
  if (hi - lo < 10) console.log("   (shock range too narrow to tell the models apart yet)");
  else
    console.log(
      scaled.cv < plain.cv
        ? "   → rep looks scaled by (1 − shock/100): recovery raises output\n"
        : "   → rep doesn't track shock: shock seems to cost exp only, recovery mostly isn't worth output\n",
    );
}

// ---- 4: break-even ----
console.log("4. break-even (assuming output ∝ 1 − shock/100)");
if (!(extra > 0)) console.log("   need recovery samples first (the rotation logs them)");
else
  for (const S of [95, 75, 50, 25]) {
    const H = ((1 - S / 100) * 100) / extra;
    console.log(`   at shock ${S}: an hour of recovery pays back if the sleeve keeps it ≥ ${fmt(H)} h`);
  }

function fmt(x) {
  return Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : "?";
}
