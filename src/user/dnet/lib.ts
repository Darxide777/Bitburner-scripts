// Bitburner single-player game module. Everything here uses the game's own files and
// `ns.dnet` API inside one save; it does not access real networks, hosts, or credentials.
import type { CacheResult, DarknetResult, NS } from "@ns";

export const MODEL = {
  echo: "DeskMemo_3.1",
  sortedEcho: "PHP 5.4",
  noPassword: "ZeroLogon",
  captcha: "CloudBlare(tm)",
  defaultPassword: "FreshInstall_1.0",
  bufferOverflow: "Pr0verFl0",
  mastermind: "DeepGreen",
  timing: "2G_cellular",
  prime: "PrimeTime 2",
  roman: "BellaCuore",
  dog: "Laika4",
  guess: "AccountsManager_4.2",
  common: "TopPass",
  eu: "EuroZone Free",
  yesnt: "NIL",
  binary: "110100100",
  spice: "RateMyPix.Auth",
  base10: "OctantVoxel",
  expression: "MathML",
  divisibility: "Factori-Os",
  triple: "BigMo%od",
  hill: "KingOfTheHill",
  sniff: "OpenWebAccessPoint",
  xor: "OrdoXenos",
  labyrinth: "(The Labyrinth)",
};

export const LAB_HOSTS = [
  { host: "th3_l4byr1nth", name: "NormalLab", tier: 1 },
  { host: "cru3l_l4byr1nth", name: "CruelLab", tier: 2 },
  { host: "m3rc1l3ss_l4byr1nth", name: "MercilessLab", tier: 3 },
  { host: "ub3r_l4byr1nth", name: "UberLab", tier: 4 },
  { host: "et3rn4l_l4byr1nth", name: "EternalLab", tier: 5 },
  { host: "end13ss_l4byr1nth", name: "EndlessLab", tier: 6 },
  { host: "f1n4l_l4byr1nth", name: "FinalLab", tier: 7 },
  { host: "b0nus_l4byr1nth", name: "BonusLab", tier: 8 },
] as const;

export interface LabStatus {
  host: string;
  name: string;
  tier: number;
  depth: number;
  charisma: number;
}

export const DIGITS = "0123456789";
export const LOWER = "abcdefghijklmnopqrstuvwxyz";
export const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const LETTERS = LOWER + UPPER;
export const ALNUM = DIGITS + LETTERS;
export const PRINTABLE = ALNUM + " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

// Fallback candidates for Bitburner's fictional password models, not real credentials.
export const DEFAULT_PASSWORDS = ["admin", "password", "0000", "12345"];
export const DOG_NAMES = ["fido", "spot", "rover", "max"];

export const EU_COUNTRIES = [
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Republic of Cyprus",
  "Czech Republic",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Ireland",
  "Italy",
  "Latvia",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Netherlands",
  "Poland",
  "Portugal",
  "Romania",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
];

export const COMMON_PASSWORDS = [
  "123456",
  "password",
  "12345678",
  "qwerty",
  "123456789",
  "12345",
  "1234",
  "111111",
  "1234567",
  "dragon",
  "123123",
  "baseball",
  "abc123",
  "football",
  "monkey",
  "letmein",
  "696969",
  "shadow",
  "master",
  "666666",
  "qwertyuiop",
  "123321",
  "mustang",
  "1234567890",
  "michael",
  "654321",
  "superman",
  "1qaz2wsx",
  "7777777",
  "121212",
  "0",
  "qazwsx",
  "123qwe",
  "trustno1",
  "jordan",
  "jennifer",
  "zxcvbnm",
  "asdfgh",
  "hunter",
  "buster",
  "soccer",
  "harley",
  "batman",
  "andrew",
  "tigger",
  "sunshine",
  "iloveyou",
  "2000",
  "charlie",
  "robert",
  "thomas",
  "hockey",
  "ranger",
  "daniel",
  "starwars",
  "112233",
  "george",
  "computer",
  "michelle",
  "jessica",
  "pepper",
  "1111",
  "zxcvbn",
  "555555",
  "11111111",
  "131313",
  "freedom",
  "777777",
  "pass",
  "maggie",
  "159753",
  "aaaaaa",
  "ginger",
  "princess",
  "joshua",
  "cheese",
  "amanda",
  "summer",
  "love",
  "ashley",
  "6969",
  "nicole",
  "chelsea",
  "biteme",
  "matthew",
  "access",
  "yankees",
  "987654321",
  "dallas",
  "austin",
  "thunder",
  "taylor",
  "matrix",
];

export const SMALL_PRIMES = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79,
  83, 89, 97,
];

export const LARGE_PRIMES = [
  1069, 1409, 1471, 1567, 1597, 1601, 1697, 1747, 1801, 1889, 1979, 1999, 2063, 2207,
  2371, 2503, 2539, 2693, 2741, 2753, 2801, 2819, 2837, 2909, 2939, 3169, 3389, 3571,
  3761, 3881, 4217, 4289, 4547, 4729, 4789, 4877, 4943, 4951, 4957, 5393, 5417, 5419,
  5441, 5519, 5527, 5647, 5779, 5881, 6007, 6089, 6133, 6389, 6451, 6469, 6547, 6661,
  6719, 6841, 7103, 7549, 7559, 7573, 7691, 7753, 7867, 8053, 8081, 8221, 8329, 8599,
  8677, 8761, 8839, 8963, 9103, 9199, 9343, 9467, 9551, 9601, 9739, 9749, 9859,
];

export const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type Store = Record<string, string>;

export const REWARD_PORT = 19;

export interface DnetPaths {
  dir: string;
  lib: string;
  solvers: string;
  roamer: string;
  lab: string;
  setup: string;
  store: string;
  charisma: string;
  snap: string;
  rewards: string;
}

export interface Feedback {
  data?: unknown;
  message?: string;
  code?: number;
  passwordAttempted?: string;
  [key: string]: unknown;
}

export interface AuthAttempt {
  success: boolean;
  result: (DarknetResult & { data?: unknown }) | null;
}

export interface BatchOutcome {
  successPassword?: string;
  noFeedback?: boolean;
  reason?: string;
  results?: Map<string, Feedback>;
}

export interface SolvedPassword {
  password: string | null;
  reason: string;
}

export function normalizeDir(scriptName: string): string {
  if (!scriptName.includes("/")) return "";
  const parts = scriptName.split("/").slice(0, -1);
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.length ? out.join("/") + "/" : "";
}

export function paths(ns: NS): DnetPaths {
  const dir = normalizeDir(ns.getScriptName());
  return {
    dir,
    lib: dir + "lib.js",
    solvers: dir + "solvers.js",
    roamer: dir + "roamer.js",
    lab: dir + "lab.js",
    setup: dir + "setup.js",
    // Generated in-game strings only; this file never contains real-world credentials.
    store: dir + "passwords.json",
    charisma: dir + "charisma.txt",
    snap: dir + "snap.json",
    rewards: dir + "rewards.txt",
  };
}

export function readLabStatus(ns: NS): LabStatus | null {
  for (const lab of LAB_HOSTS) {
    try {
      const details = ns.dnet.getServerDetails(lab.host);
      if (!details || details.isOnline === false || details.modelId !== MODEL.labyrinth) continue;
      return {
        host: lab.host,
        name: lab.name,
        tier: lab.tier,
        depth: details.depth,
        charisma: details.requiredCharismaSkill,
      };
    } catch {}
  }
  return null;
}

export function recordReward(ns: NS, host: string, file: string, result: CacheResult): void {
  try {
    const line =
      new Date().toISOString() +
      " " +
      host +
      " " +
      file +
      ": " +
      result.message +
      " (karma " +
      String(result.karmaLoss) +
      ")";
    ns.tryWritePort(REWARD_PORT, line);
  } catch {}
}

export function loadStore(ns: NS): Store {
  try {
    const raw = ns.read(paths(ns).store);
    if (!raw) return {};
    const obj: unknown = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Store) : {};
  } catch {
    return {};
  }
}

export function saveStore(ns: NS, store: Store): void {
  try {
    ns.write(paths(ns).store, JSON.stringify(store), "w");
  } catch {}
}

export function mergeInto(target: Store, extra: unknown): boolean {
  let changed = false;
  if (!extra || typeof extra !== "object") return false;
  for (const key of Object.keys(extra)) {
    const value = (extra as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    if (target[key] !== value) {
      target[key] = value;
      changed = true;
    }
  }
  return changed;
}

export function storeHash(store: Store): number {
  const keys = Object.keys(store).sort();
  let h = 0;
  for (const k of keys) {
    const s = k + "=" + store[k] + ";";
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export function writeSnapshot(ns: NS, store: Store): string | null {
  const p = paths(ns);
  try {
    ns.write(p.snap, JSON.stringify(store), "w");
    return p.snap;
  } catch {
    return null;
  }
}

export function mergeLocalSnapshots(ns: NS, store: Store): boolean {
  let changed = false;
  const keep = paths(ns).snap;
  let files: string[] = [];
  try {
    files = ns.ls(ns.getHostname()).filter((file) => file === keep || file.startsWith("dnet-snap"));
  } catch {
    return false;
  }
  for (const file of files) {
    try {
      const raw = ns.read(file);
      if (raw) {
        const obj: unknown = JSON.parse(raw);
        if (mergeInto(store, obj)) changed = true;
      }
    } catch {}
    if (file !== keep) {
      try {
        ns.rm(file);
      } catch {}
    }
  }
  return changed;
}

export function pushSnapshotTo(ns: NS, store: Store, host: string): boolean {
  const name = writeSnapshot(ns, store);
  if (!name) return false;
  let ok = false;
  try {
    ok = ns.scp(name, host);
  } catch {
    ok = false;
  }
  try {
    ns.rm(name);
  } catch {}
  return ok;
}

export function pushSnapshotToHome(ns: NS, store: Store): boolean {
  return pushSnapshotTo(ns, store, "home");
}

export async function authenticateRetry(ns: NS, host: string, password: string, tries = 3): Promise<AuthAttempt> {
  let last: (DarknetResult & { data?: unknown }) | null = null;
  for (let i = 0; i < tries; i++) {
    let result: DarknetResult & { data?: unknown };
    try {
      result = await ns.dnet.authenticate(host, password);
    } catch (e) {
      result = { success: false, code: 408, message: String(e) };
    }
    last = result;
    if (result.success) return { success: true, result };
    if (result.code === 408 || result.code === 351 || result.code === 503) {
      await ns.sleep(200);
      continue;
    }
    return { success: false, result };
  }
  return { success: false, result: last };
}

export async function askBatch(ns: NS, host: string, passwords: string[]): Promise<BatchOutcome> {
  const unique = [...new Set(passwords.filter((p) => typeof p === "string"))];
  const results = new Map<string, Feedback>();
  const batchSize = 10;
  for (let start = 0; start < unique.length; start += batchSize) {
    const group = unique.slice(start, start + batchSize);
    for (const password of group) {
      for (let attemptIndex = 0; attemptIndex < 3; attemptIndex++) {
        let result: DarknetResult & { data?: unknown };
        try {
          result = await ns.dnet.authenticate(host, password);
        } catch (e) {
          result = { success: false, code: 408, message: String(e) };
        }
        if (result.success) return { successPassword: password };
        if (result.code === 351) return { noFeedback: true, reason: "not connected" };
        if (result.code === 408 || result.code === 503) {
          await ns.sleep(200);
          continue;
        }
        break;
      }
    }
    let hb: (DarknetResult & { logs: string[] }) | null = null;
    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex++) {
      try {
        hb = await ns.dnet.heartbleed(host, { logsToCapture: 200 });
      } catch (e) {
        hb = { success: false, code: 408, message: String(e), logs: [] };
      }
      if (hb.success) break;
      if (hb.code === 451) return { noFeedback: true, reason: "charisma" };
      if (hb.code === 408 || hb.code === 351 || hb.code === 503) {
        await ns.sleep(200);
        hb = null;
        continue;
      }
      return { noFeedback: true, reason: hb.message };
    }
    if (!hb || !hb.success) return { noFeedback: true, reason: "feedback timeout" };
    const wanted = new Set(group);
    for (const line of hb.logs || []) {
      let msg: Feedback | null = null;
      try {
        msg = JSON.parse(line) as Feedback;
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object") continue;
      if (msg.code === 200) continue;
      if (typeof msg.passwordAttempted !== "string") continue;
      if (!wanted.has(msg.passwordAttempted)) continue;
      if (!results.has(msg.passwordAttempted)) results.set(msg.passwordAttempted, msg);
    }
  }
  return { results };
}

export async function ask(ns: NS, host: string, password: string): Promise<{ success: boolean; feedback?: Feedback; noFeedback?: boolean; reason?: string }> {
  const batch = await askBatch(ns, host, [password]);
  if (batch.successPassword !== undefined) return { success: true };
  if (batch.noFeedback) return { success: false, noFeedback: true, reason: batch.reason };
  const feedback = batch.results && batch.results.get(password);
  if (feedback) return { success: false, feedback };
  return { success: false, noFeedback: true, reason: "no feedback" };
}

export function chunk<T>(array: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

export function dataOf(feedback: Feedback | null | undefined): unknown {
  if (!feedback) return "";
  if (feedback.data !== undefined && feedback.data !== null) return feedback.data;
  if (feedback.message !== undefined && feedback.message !== null) return feedback.message;
  return "";
}

export async function tryStatic(ns: NS, host: string, candidates: string[]): Promise<SolvedPassword> {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const r = await authenticateRetry(ns, host, candidate);
    if (r.success) return { password: candidate, reason: "" };
    if (r.result && r.result.code === 351) return { password: null, reason: "not connected" };
  }
  return { password: null, reason: "candidates exhausted" };
}

export function alphabetFor(format: string): string {
  if (format === "numeric") return DIGITS;
  if (format === "alphabetic") return LETTERS;
  if (format === "alphanumeric") return ALNUM;
  if (format === "ASCII") return PRINTABLE;
  return ALNUM;
}

export function fillerFor(format: string): string {
  const alphabet = alphabetFor(format);
  for (const c of ["#", "x", "9", "~", "\u0001"]) {
    if (!alphabet.includes(c)) return c;
  }
  return "\u0001";
}

export function romanToInt(input: unknown): number {
  if (!input) return 0;
  const text = String(input).trim();
  if (text.toLowerCase() === "nulla") return 0;
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let prev = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const value = map[text[i].toUpperCase()];
    if (value === undefined) continue;
    if (value < prev) total -= value;
    else total += value;
    prev = value;
  }
  return total;
}

export function parseBaseN(numberString: string, base: number): number {
  let result = 0;
  let index = 0;
  const dot = numberString.split(".")[0].length;
  let digit = dot - 1;
  while (index < numberString.length) {
    const ch = numberString[index];
    if (ch === ".") {
      index++;
      continue;
    }
    result += BASE36.indexOf(ch) * base ** digit;
    index++;
    digit--;
  }
  return result;
}

export function cleanExpression(raw: unknown): string {
  const text = String(raw)
    .replaceAll("\u04b3", "*")
    .replaceAll("\u00f7", "/")
    .replaceAll("\u2795", "+")
    .replaceAll("\u2796", "-")
    .replaceAll("ns.exit(),", "");
  return text.split(",")[0];
}

export function evalArithmetic(expression: string): number {
  const tokens = cleanExpression(expression).split("");
  let currentDepth = 0;
  const depth = tokens.map((token) => {
    if (token === "(") {
      currentDepth += 1;
    } else if (token === ")") {
      currentDepth -= 1;
      return currentDepth + 1;
    }
    return currentDepth;
  });
  const depth1Start = depth.indexOf(1);
  const firstZero = depth.indexOf(0, depth1Start);
  const depth1End = firstZero === -1 ? depth.length - 1 : firstZero - 1;
  if (depth1Start !== -1) {
    const subExpression = tokens.slice(depth1Start + 1, depth1End).join("");
    const result = evalArithmetic(subExpression);
    tokens.splice(depth1Start, depth1End - depth1Start + 1, result.toString());
    return evalArithmetic(tokens.join(""));
  }

  let remaining = tokens.join("");
  const multiplicationDivisionRegex = /(-?\d*\.?\d+) *([*/]) *(-?\d*\.?\d+)/;
  let match = remaining.match(multiplicationDivisionRegex);
  while (match) {
    const left = parseFloat(match[1]);
    const operator = match[2];
    const right = parseFloat(match[3]);
    const result = operator === "*" ? left * right : left / right;
    const resultString = Math.abs(result) < 0.000001 ? result.toFixed(20) : result.toString();
    remaining = remaining.replace(match[0], resultString);
    match = remaining.match(multiplicationDivisionRegex);
  }

  const additionSubtractionRegex = /(-?\d*\.?\d+) *([+-]) *(-?\d*\.?\d+)/;
  match = remaining.match(additionSubtractionRegex);
  while (match) {
    const left = parseFloat(match[1]);
    const operator = match[2];
    const right = parseFloat(match[3]);
    const result = operator === "+" ? left + right : left - right;
    remaining = remaining.replace(match[0], result.toString());
    match = remaining.match(additionSubtractionRegex);
  }

  const leftover = remaining.match(/(-?\d*\.?\d+)/);
  return leftover ? parseFloat(leftover[0]) : NaN;
}

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

export function modInverse(a: number, m: number): number | null {
  if (m === 1) return 0;
  a = ((a % m) + m) % m;
  let [oldR, r] = [a, m];
  let [oldS, s] = [1, 0];
  while (r !== 0) {
    const q = Math.floor(oldR / r);
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1) return null;
  return ((oldS % m) + m) % m;
}

export function crt(residues: [number, number][]): [number, number] {
  let a = 0;
  let m = 1;
  for (const pair of residues) {
    const r = pair[0];
    const n = pair[1];
    if (!Number.isFinite(r) || !Number.isFinite(n) || n <= 0) continue;
    const g = gcd(m, n);
    if ((r - a) % g !== 0) continue;
    const m1 = m / g;
    const n1 = n / g;
    const inv = modInverse(((m1 % n1) + n1) % n1, n1);
    if (inv === null) continue;
    const t = ((((r - a) / g) % n1) + n1) % n1;
    const k = (t * inv) % n1;
    const lcm = m * n1;
    a = (((a + m * k) % lcm) + lcm) % lcm;
    m = lcm;
  }
  return [a, m];
}

export function uniquePermutations(text: string): string[] {
  const chars = String(text).split("").sort();
  const used = new Array(chars.length).fill(false);
  const current: string[] = [];
  const out = new Set<string>();
  function rec() {
    if (current.length === chars.length) {
      out.add(current.join(""));
      return;
    }
    for (let i = 0; i < chars.length; i++) {
      if (used[i]) continue;
      if (i > 0 && chars[i] === chars[i - 1] && !used[i - 1]) continue;
      used[i] = true;
      current.push(chars[i]);
      rec();
      current.pop();
      used[i] = false;
    }
  }
  rec();
  return [...out];
}

export function assignmentsFor(sets: string[][], multiset: string): string[] {
  const counts: Record<string, number> = {};
  for (const c of String(multiset)) counts[c] = (counts[c] || 0) + 1;
  const out: string[] = [];
  const current: string[] = [];
  function rec(k: number) {
    if (out.length >= 5000) return;
    if (k === sets.length) {
      out.push(current.join(""));
      return;
    }
    for (const d of sets[k]) {
      if (!counts[d]) continue;
      counts[d]--;
      current.push(d);
      rec(k + 1);
      current.pop();
      counts[d]++;
    }
  }
  rec(0);
  return out;
}
