// Pure formatting helpers (no NS calls → 0 GB RAM).

const SUFFIXES = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n"];

export function num(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return n > 0 ? "∞" : n < 0 ? "-∞" : "—";
  const sign = n < 0 ? "-" : "";
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1000 && i < SUFFIXES.length - 1) {
    v /= 1000;
    i++;
  }
  if (v >= 1000) return sign + Math.abs(n).toExponential(digits);
  return sign + (i === 0 && Number.isInteger(v) ? String(v) : v.toFixed(digits)) + SUFFIXES[i];
}

export const money = (n: number, digits = 2) => (n < 0 ? "-$" + num(-n, digits) : "$" + num(n, digits));

export function ram(gb: number): string {
  const units = ["GB", "TB", "PB", "EB"];
  let i = 0;
  while (gb >= 1024 && i < units.length - 1) {
    gb /= 1024;
    i++;
  }
  return `${gb.toFixed(gb < 10 && i > 0 ? 2 : 0)}${units[i]}`;
}

/** Duration in ms → "3d 4h", "12m 5s", "∞". */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "∞";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

export function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  if (str.length >= n) return str.slice(0, n);
  return right ? str.padStart(n) : str.padEnd(n);
}
