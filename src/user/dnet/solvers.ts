// Bitburner single-player game module: solvers for the fictional darknet's generated
// password models. All values come from the game, not real credentials or services.
import type { DarknetServerDetails, NS } from "@ns";
import {
  MODEL,
  COMMON_PASSWORDS,
  EU_COUNTRIES,
  DOG_NAMES,
  DEFAULT_PASSWORDS,
  SMALL_PRIMES,
  LARGE_PRIMES,
  alphabetFor,
  fillerFor,
  ask,
  askBatch,
  authenticateRetry,
  tryStatic,
  dataOf,
  chunk,
  romanToInt,
  parseBaseN,
  evalArithmetic,
  crt,
  uniquePermutations,
  type Feedback,
  type SolvedPassword,
} from "./lib.js";

type Details = DarknetServerDetails & { isOnline?: boolean };

function ok(password: string): SolvedPassword {
  return { password, reason: "" };
}

function fail(reason: string): SolvedPassword {
  return { password: null, reason };
}

async function ensureData(ns: NS, host: string, details: Details): Promise<string> {
  if (details.data) return String(details.data);
  const r = await ask(ns, host, "!");
  if (r.success) return "";
  return r.feedback ? String(dataOf(r.feedback)) : "";
}

function lengthFiltered(list: string[], details: Details): string[] {
  const L = Number(details.passwordLength);
  if (!L) return list;
  const filtered = list.filter((entry) => entry.length === L);
  return filtered.length ? filtered : list;
}

async function solveNoPassword(ns: NS, host: string): Promise<SolvedPassword> {
  return tryStatic(ns, host, [""]);
}

async function solveEcho(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const hint = String(details.passwordHint || "").trim();
  if (!hint) return fail("no hint");
  const tokens = hint.split(/\s+/);
  const raw = tokens[tokens.length - 1];
  const cleaned = raw.replace(/[.,!?;:'"]+$/, "");
  const candidates = cleaned && cleaned !== raw ? [cleaned, raw] : [raw];
  return tryStatic(ns, host, candidates);
}

async function solveCaptcha(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const data = await ensureData(ns, host, details);
  const password = String(data)
    .split("")
    .filter((c) => /\d/.test(c))
    .join("");
  if (!password) return fail("no captcha digits");
  return tryStatic(ns, host, [password]);
}

function parseRmsd(feedback: Feedback, L: number): number | null {
  const match = /RMS Deviation:\s*(-?\d+(?:\.\d+)?)/.exec(String(dataOf(feedback)));
  if (!match) return null;
  const rmsd = parseFloat(match[1]);
  if (!Number.isFinite(rmsd)) return null;
  return L * rmsd * rmsd;
}

async function solveSortedEcho(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const L = Number(details.passwordLength);
  const data = await ensureData(ns, host, details);
  const sorted = String(data).replace(/[^0-9]/g, "");
  if (!sorted || sorted.length !== L) return fail("bad sorted password");
  if (L < 5) {
    const candidates = uniquePermutations(sorted).filter((p) => L === 1 || p[0] !== "0");
    return tryStatic(ns, host, candidates);
  }

  const digits = sorted.split("").map(Number);
  const baseline = await ask(ns, host, sorted);
  if (baseline.success) return ok(sorted);
  if (!baseline.feedback) return fail(baseline.reason || "no sorted echo feedback");
  const E0 = parseRmsd(baseline.feedback, L);
  if (E0 === null) return fail("no rmsd");

  const pairs: [number, number, number, number][] = [];
  const guesses: string[] = [];
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      if (digits[i] === digits[j]) continue;
      const arr = digits.slice();
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
      pairs.push([i, j, digits[i], digits[j]]);
      guesses.push(arr.join(""));
    }
  }
  if (!pairs.length) return fail("no distinguishable digits");

  const adjacency = new Map<number, [number, number][]>();
  for (let i = 0; i < L; i++) adjacency.set(i, []);
  for (const group of chunk(guesses, 10)) {
    const batch = await askBatch(ns, host, group);
    if (batch.successPassword !== undefined) return ok(batch.successPassword);
    if (batch.noFeedback) return fail(batch.reason || "no feedback");
    for (const guess of group) {
      const fb = batch.results && batch.results.get(guess);
      if (!fb) continue;
      const E = parseRmsd(fb, L);
      if (E === null) continue;
      const pairIndex = guesses.indexOf(guess);
      if (pairIndex === -1) continue;
      const [i, j, gi, gj] = pairs[pairIndex];
      const weight = Math.round((E - E0) / (2 * (gi - gj)));
      adjacency.get(i)?.push([j, weight]);
      adjacency.get(j)?.push([i, -weight]);
    }
  }

  const rel: (number | null)[] = new Array(L).fill(null);
  rel[0] = 0;
  const queue = [0];
  while (queue.length) {
    const a = queue.shift()!;
    for (const [b, weight] of adjacency.get(a) ?? []) {
      if (rel[b] === null) {
        rel[b] = rel[a]! - weight;
        queue.push(b);
      }
    }
  }
  if (rel.some((value) => value === null)) return fail("reconstruction incomplete");

  const targetKey = digits.slice().sort().join("");
  const candidates = new Set<string>();
  for (let pr = 0; pr <= 9; pr++) {
    const password = rel.map((value) => pr + value!);
    if (password.some((value) => value < 0 || value > 9)) continue;
    if (L > 1 && password[0] === 0) continue;
    const text = password.join("");
    if (text.split("").sort().join("") !== targetKey) continue;
    candidates.add(text);
  }
  if (!candidates.size) return fail("no reconstruction");
  return tryStatic(ns, host, [...candidates]);
}

function exactCount(feedback: Feedback): number | null {
  const text = String(dataOf(feedback));
  const parts = text.split(",");
  const value = parseInt(parts[0], 10);
  return Number.isFinite(value) ? value : null;
}

function mastermindTotal(feedback: Feedback): number | null {
  const text = String(dataOf(feedback));
  const parts = text.split(",");
  const exact = parseInt(parts[0], 10);
  const misplaced = parseInt(parts[1], 10);
  if (!Number.isFinite(exact) || !Number.isFinite(misplaced)) return null;
  return exact + misplaced;
}

function pepperCount(feedback: Feedback): number | null {
  const text = String(dataOf(feedback));
  const part = text.split("/")[0];
  if (!part) return null;
  if (part === "0") return 0;
  return part.split("🌶️").length - 1;
}

async function solveCountModel(ns: NS, host: string, details: Details, mode: "mastermind" | "spice"): Promise<SolvedPassword> {
  const L = Number(details.passwordLength);
  if (!L) return fail("bad password length");
  const alphabet = alphabetFor(details.passwordFormat).split("");
  const filler = fillerFor(details.passwordFormat);
  const parseProbe = mode === "mastermind" ? mastermindTotal : pepperCount;
  const parseExact = mode === "mastermind" ? exactCount : pepperCount;

  const counts: Record<string, number> = {};
  let total = 0;
  let countsComplete = true;
  for (const group of chunk(alphabet, 10)) {
    const probes = group.map((c) => c.repeat(L));
    const batch = await askBatch(ns, host, probes);
    if (batch.successPassword !== undefined) return ok(batch.successPassword);
    if (batch.noFeedback) return fail(batch.reason || "no feedback");
    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      const fb = batch.results && batch.results.get(probes[i]);
      if (!fb) {
        countsComplete = false;
        continue;
      }
      const count = parseProbe(fb);
      if (count === null) {
        countsComplete = false;
        continue;
      }
      counts[c] = count;
      total += count;
    }
  }
  if (total !== L) countsComplete = false;

  const password: (string | null)[] = new Array(L).fill(null);
  for (let position = 0; position < L; position++) {
    let candidates = countsComplete ? alphabet.filter((c) => counts[c] > 0) : alphabet.slice();
    if (!candidates.length) candidates = alphabet.slice();
    let assigned = false;
    for (const group of chunk(candidates, 10)) {
      const guesses = group.map((c) => filler.repeat(position) + c + filler.repeat(L - position - 1));
      const batch = await askBatch(ns, host, guesses);
      if (batch.successPassword !== undefined) return ok(batch.successPassword);
      if (batch.noFeedback) return fail(batch.reason || "no feedback");
      for (let i = 0; i < group.length; i++) {
        const c = group[i];
        const fb = batch.results && batch.results.get(guesses[i]);
        if (!fb) continue;
        const exact = parseExact(fb);
        if (exact === 1) {
          password[position] = c;
          if (countsComplete) counts[c] -= 1;
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }
    if (!assigned) return fail("position " + position + " unresolved");
  }

  const candidate = password.join("");
  const result = await authenticateRetry(ns, host, candidate);
  return result.success ? ok(candidate) : fail("verification failed");
}

async function solveYesnt(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const L = Number(details.passwordLength);
  if (!L) return fail("bad password length");
  const alphabet = alphabetFor(details.passwordFormat).split("");
  const password: (string | null)[] = new Array(L).fill(null);
  for (const group of chunk(alphabet, 10)) {
    const probes = group.map((c) => c.repeat(L));
    const batch = await askBatch(ns, host, probes);
    if (batch.successPassword !== undefined) return ok(batch.successPassword);
    if (batch.noFeedback) return fail(batch.reason || "no feedback");
    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      const fb = batch.results && batch.results.get(probes[i]);
      if (!fb) continue;
      const parts = String(dataOf(fb)).split(",");
      for (let position = 0; position < L; position++) {
        if (parts[position] === "yes" && password[position] === null) password[position] = c;
      }
    }
  }
  if (password.some((value) => value === null)) return fail("incomplete password");
  const candidate = password.join("");
  const result = await authenticateRetry(ns, host, candidate);
  return result.success ? ok(candidate) : fail("verification failed");
}

async function solveTiming(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const L = Number(details.passwordLength);
  if (!L) return fail("bad password length");
  const alphabet = alphabetFor(details.passwordFormat).split("");
  const filler = fillerFor(details.passwordFormat);
  const password: string[] = [];
  for (let position = 0; position < L; position++) {
    const prefix = password.join("");
    let found: string | null = null;
    for (const group of chunk(alphabet, 10)) {
      const guesses = group.map((c) => prefix + c + filler.repeat(L - position - 1));
      const batch = await askBatch(ns, host, guesses);
      if (batch.successPassword !== undefined) return ok(batch.successPassword);
      if (batch.noFeedback) return fail(batch.reason || "no feedback");
      for (let i = 0; i < group.length; i++) {
        const fb = batch.results && batch.results.get(guesses[i]);
        if (!fb) continue;
        const match = /\((-?\d+)\)/.exec(String(fb.message || ""));
        if (!match) continue;
        const index = parseInt(match[1], 10);
        if (index > position) {
          found = group[i];
          break;
        }
      }
      if (found !== null) break;
    }
    if (found === null) return fail("position " + position + " unresolved");
    password.push(found);
  }
  const candidate = password.join("");
  const result = await authenticateRetry(ns, host, candidate);
  return result.success ? ok(candidate) : fail("verification failed");
}

async function solvePrime(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const data = await ensureData(ns, host, details);
  const raw = String(data).replace(/[^0-9]/g, "");
  if (!raw) return fail("no target number");
  let number: bigint;
  try {
    number = BigInt(raw);
  } catch {
    return fail("bad target number");
  }
  if (number <= 1n) return fail("bad target number");
  for (const prime of SMALL_PRIMES) {
    const big = BigInt(prime);
    while (number % big === 0n) number /= big;
  }
  const candidate = number.toString();
  const result = await authenticateRetry(ns, host, candidate);
  return result.success ? ok(candidate) : fail("prime candidate failed");
}

async function solveRoman(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const data = String((await ensureData(ns, host, details)) || "").trim();
  if (!data) return fail("no roman data");
  if (data.includes(",")) {
    const parts = data.split(",");
    let low = romanToInt(parts[0]);
    let high = romanToInt(parts[1]);
    if (low > high) {
      const tmp = low;
      low = high;
      high = tmp;
    }
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const result = await ask(ns, host, String(mid));
      if (result.success) return ok(String(mid));
      if (!result.feedback) return fail(result.reason || "no roman feedback");
      const text = String(dataOf(result.feedback));
      if (text.includes("ALTUS NIMIS")) high = mid - 1;
      else if (text.includes("PARUM BREVIS")) low = mid + 1;
      else return fail("unknown roman feedback");
    }
    return fail("roman range exhausted");
  }
  if (/^-?\d+$/.test(data)) return tryStatic(ns, host, [data]);
  const candidate = String(romanToInt(data));
  return tryStatic(ns, host, [candidate]);
}

async function solveGuess(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const L = Number(details.passwordLength);
  if (!L) return fail("bad password length");
  let low = 0;
  let high = 10 ** L - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const result = await ask(ns, host, String(mid));
    if (result.success) return ok(String(mid));
    if (!result.feedback) return fail(result.reason || "no guess feedback");
    const text = String(dataOf(result.feedback));
    if (text.includes("Lower")) high = mid - 1;
    else if (text.includes("Higher")) low = mid + 1;
    else return fail("unknown guess feedback");
  }
  return fail("guess range exhausted");
}

async function solveList(ns: NS, host: string, details: Details, list: string[]): Promise<SolvedPassword> {
  return tryStatic(ns, host, lengthFiltered(list, details));
}

async function solveBufferOverflow(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const L = Number(details.passwordLength);
  if (!L) return fail("bad password length");
  for (const character of ["a", "b"]) {
    const candidate = character.repeat(2 * L);
    const result = await authenticateRetry(ns, host, candidate);
    if (result.success) return ok(candidate);
  }
  return fail("buffer overflow failed");
}

async function solveBinary(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const data = String((await ensureData(ns, host, details)) || "");
  const parts = data.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fail("no binary data");
  let candidate = "";
  for (const part of parts) {
    const code = parseInt(part, 2);
    if (Number.isNaN(code)) return fail("bad binary data");
    candidate += String.fromCharCode(code);
  }
  if (!candidate) return fail("empty binary password");
  return tryStatic(ns, host, [candidate]);
}

async function solveBase10(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const data = String((await ensureData(ns, host, details)) || "");
  const comma = data.indexOf(",");
  if (comma < 0) return fail("bad base data");
  const base = parseFloat(data.slice(0, comma));
  const encoded = data.slice(comma + 1).trim();
  if (!Number.isFinite(base) || !encoded) return fail("bad base data");
  const value = parseBaseN(encoded, base);
  if (!Number.isFinite(value)) return fail("bad base value");
  return tryStatic(ns, host, [String(Math.round(value)), String(value)]);
}

async function solveExpression(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const data = String((await ensureData(ns, host, details)) || "");
  if (!data) return fail("no expression");
  const value = evalArithmetic(data);
  if (Number.isNaN(value)) return tryStatic(ns, host, ["NaN"]);
  if (!Number.isFinite(value)) return tryStatic(ns, host, [String(value)]);
  return tryStatic(ns, host, [String(value)]);
}

type ProbeOutcome = { error?: string; password?: string } | null;

async function solveDivisibility(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const primes = [...SMALL_PRIMES, ...LARGE_PRIMES];
  const known = new Map<number, boolean>();
  const probeBatch = async (values: number[]): Promise<ProbeOutcome> => {
    for (const group of chunk(values, 10)) {
      const batch = await askBatch(ns, host, group.map(String));
      if (batch.successPassword !== undefined) return { password: batch.successPassword };
      if (batch.noFeedback) return { error: batch.reason || "no feedback" };
      for (const prime of group) {
        const fb = batch.results && batch.results.get(String(prime));
        if (fb) known.set(prime, String(dataOf(fb)).trim() === "true");
      }
    }
    return null;
  };

  const first = await probeBatch(primes);
  if (first && first.error) return fail(first.error);
  if (first && typeof first.password === "string") return ok(first.password);
  const missing = primes.filter((prime) => !known.has(prime));
  if (missing.length) {
    const second = await probeBatch(missing);
    if (second && second.error) return fail(second.error);
    if (second && typeof second.password === "string") return ok(second.password);
  }

  let product = 1n;
  for (const prime of primes) {
    if (known.get(prime) !== true) continue;
    let exponent = 1n;
    let next = BigInt(prime) * BigInt(prime);
    while (true) {
      const result = await ask(ns, host, next.toString());
      if (result.success) return ok(next.toString());
      if (!result.feedback) return fail(result.reason || "no feedback");
      if (String(dataOf(result.feedback)).trim() === "true") {
        exponent += 1n;
        next *= BigInt(prime);
      } else {
        break;
      }
    }
    product *= BigInt(prime) ** exponent;
  }

  const candidate = product.toString();
  const result = await authenticateRetry(ns, host, candidate);
  return result.success ? ok(candidate) : fail("factorization incomplete");
}

async function solveTripleModulo(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const moduli: number[] = [];
  for (let n = 2; n <= 32; n++) moduli.push(n);
  const probes = moduli.map(String);
  const batch = await askBatch(ns, host, probes);
  if (batch.successPassword !== undefined) return ok(batch.successPassword);
  if (batch.noFeedback) return fail(batch.reason || "no feedback");

  const residues: [number, number][] = [];
  for (let i = 0; i < moduli.length; i++) {
    const fb = batch.results && batch.results.get(probes[i]);
    if (!fb) continue;
    const value = Number(String(dataOf(fb)).trim());
    if (Number.isFinite(value)) residues.push([value, moduli[i]]);
  }
  if (residues.length < 10) return fail("insufficient residues");

  const [base, modulus] = crt(residues);
  const L = Number(details.passwordLength);
  const low = L <= 1 ? 0 : 10 ** (L - 1);
  const high = 10 ** L - 1;
  const expected = Math.ceil((high - low + 1) / modulus);
  if (!Number.isFinite(expected) || expected > 200) return fail("insufficient residues");
  let candidate = base;
  if (candidate < low) candidate += Math.ceil((low - candidate) / modulus) * modulus;
  let attempts = 0;
  while (candidate <= high && attempts < 250) {
    const result = await authenticateRetry(ns, host, String(candidate));
    if (result.success) return ok(String(candidate));
    if (result.result && result.result.code === 351) return fail("not connected");
    candidate += modulus;
    attempts += 1;
  }
  return fail("triple modulo candidates exhausted");
}

async function solveHill(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const L = Number(details.passwordLength);
  if (!L) return fail("bad password length");
  const low = L <= 1 ? 0 : 10 ** (L - 1);
  const high = 10 ** L - 1;
  if (L <= 2) {
    for (let x = low; x <= high; x++) {
      const result = await authenticateRetry(ns, host, String(x));
      if (result.success) return ok(String(x));
      if (result.result && result.result.code === 351) return fail("not connected");
    }
    return fail("brute force exhausted");
  }

  const width = 10 ** Math.max(L - 2, 0) + 1;
  const step = Math.max(1, Math.floor(width / 2));
  const samples: number[] = [];
  for (let x = low; x <= high; x += step) samples.push(x);
  if (samples[samples.length - 1] !== high) samples.push(high);

  const altitudes = new Map<number, number>();
  const fetchSamples = async (values: number[]): Promise<ProbeOutcome> => {
    for (const group of chunk(values, 10)) {
      const batch = await askBatch(ns, host, group.map(String));
      if (batch.successPassword !== undefined) return { password: batch.successPassword };
      if (batch.noFeedback) return { error: batch.reason || "no feedback" };
      for (const x of group) {
        const fb = batch.results && batch.results.get(String(x));
        if (!fb) continue;
        const altitude = Number(String(dataOf(fb)).trim());
        if (Number.isFinite(altitude)) altitudes.set(x, altitude);
      }
    }
    return null;
  };

  const first = await fetchSamples(samples);
  if (first && first.password !== undefined) return ok(first.password);
  if (first && first.error) return fail(first.error);
  const missing = samples.filter((x) => !altitudes.has(x));
  if (missing.length) {
    const second = await fetchSamples(missing);
    if (second && second.password !== undefined) return ok(second.password);
    if (second && second.error) return fail(second.error);
  }
  if (altitudes.size !== samples.length) return fail("incomplete altitude data");

  let bestX = samples[0];
  let bestAltitude = -Infinity;
  for (const x of samples) {
    const altitude = altitudes.get(x)!;
    if (altitude > bestAltitude) {
      bestAltitude = altitude;
      bestX = x;
    }
  }
  if (!(bestAltitude > 0)) return fail("bad altitude peak");
  const ratio = Math.min(1, bestAltitude / 10000);

  const distance = width * Math.sqrt(Math.max(0, -Math.log(ratio)));
  const candidates = new Set<number>();
  for (const base of [bestX + distance, bestX - distance]) {
    for (const offset of [0, -1, 1, -2, 2]) {
      const value = Math.round(base + offset);
      if (value >= low && value <= high) candidates.add(value);
    }
  }
  for (const x of candidates) {
    const result = await authenticateRetry(ns, host, String(x));
    if (result.success) return ok(String(x));
  }
  return fail("hill reconstruction failed");
}

function formatRegex(format: string): RegExp {
  if (format === "numeric") return /^[0-9]+$/;
  if (format === "alphabetic") return /^[a-zA-Z]+$/;
  if (format === "alphanumeric") return /^[a-zA-Z0-9]+$/;
  if (format === "ASCII") return /^[\x20-\x7e]+$/;
  return /^[\x20-\x7e]+$/;
}

function scanSniffed(packet: string, L: number, regex: RegExp): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + L <= packet.length; i++) {
    const sub = packet.slice(i, i + L);
    if (regex.test(sub)) out.add(sub);
  }
  return out;
}

async function solveSniffer(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const L = Number(details.passwordLength);
  if (!L) return fail("bad password length");
  const regex = formatRegex(details.passwordFormat);
  let candidates = new Set<string>();

  if (details.difficulty > 16) {
    const sets: Set<string>[] = [];
    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex++) {
      const probe = await ask(ns, host, "!");
      if (probe.success) return ok("!");
      if (!probe.feedback) return fail(probe.reason || "no packet");
      const set = scanSniffed(String(dataOf(probe.feedback)), L, regex);
      if (!set.size) return fail("empty sniffed packet");
      sets.push(set);
    }
    candidates = new Set([...sets[0]].filter((c) => sets[1].has(c) && sets[2].has(c)));
  } else {
    const probe = await ask(ns, host, "!");
    if (probe.success) return ok("!");
    if (!probe.feedback) return fail(probe.reason || "no packet");
    const packet = String(dataOf(probe.feedback));
    const needle = " " + host + ":";
    let index = packet.indexOf(needle);
    while (index !== -1) {
      const start = index + needle.length;
      let end = packet.indexOf(" ", start);
      if (end === -1) end = packet.length;
      const candidate = packet.slice(start, end).trim();
      if (candidate) candidates.add(candidate);
      index = packet.indexOf(needle, index + 1);
    }
    for (const candidate of scanSniffed(packet, L, regex)) candidates.add(candidate);
  }

  if (!candidates.size) return fail("no sniffed candidates");
  for (const candidate of candidates) {
    const result = await authenticateRetry(ns, host, candidate);
    if (result.success) return ok(candidate);
    if (result.result && result.result.code === 351) return fail("not connected");
  }
  return fail("sniffed candidates exhausted");
}

async function solveXor(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  const data = String((await ensureData(ns, host, details)) || "");
  const separator = data.lastIndexOf(";");
  if (separator < 0) return fail("bad xor data");
  const cipher = data.slice(0, separator);
  const masks = data
    .slice(separator + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!cipher || masks.length < cipher.length) return fail("bad xor data");
  let candidate = "";
  for (let i = 0; i < cipher.length; i++) {
    const mask = parseInt(masks[i], 2);
    if (Number.isNaN(mask)) return fail("bad xor mask");
    candidate += String.fromCharCode(cipher.charCodeAt(i) ^ mask);
  }
  return tryStatic(ns, host, [candidate]);
}

const FEEDBACK_MODELS = new Set([
  MODEL.mastermind,
  MODEL.timing,
  MODEL.guess,
  MODEL.yesnt,
  MODEL.spice,
  MODEL.hill,
  MODEL.sniff,
  MODEL.divisibility,
  MODEL.triple,
]);

export function needsFeedback(details: Details | null | undefined): boolean {
  if (!details) return false;
  if (FEEDBACK_MODELS.has(details.modelId)) return true;
  if (details.modelId === MODEL.roman) return String(details.data || "").includes(",");
  if (details.modelId === MODEL.sortedEcho) return Number(details.passwordLength) >= 5;
  return false;
}

export async function solve(ns: NS, host: string, details: Details): Promise<SolvedPassword> {
  if (!details || details.isOnline === false) return fail("offline");
  const model = details.modelId;
  if (model === MODEL.labyrinth) return fail("labyrinth");
  switch (model) {
    case MODEL.noPassword:
      return solveNoPassword(ns, host);
    case MODEL.echo:
      return solveEcho(ns, host, details);
    case MODEL.sortedEcho:
      return solveSortedEcho(ns, host, details);
    case MODEL.captcha:
      return solveCaptcha(ns, host, details);
    case MODEL.defaultPassword:
      return solveList(ns, host, details, DEFAULT_PASSWORDS);
    case MODEL.bufferOverflow:
      return solveBufferOverflow(ns, host, details);
    case MODEL.mastermind:
      return solveCountModel(ns, host, details, "mastermind");
    case MODEL.timing:
      return solveTiming(ns, host, details);
    case MODEL.prime:
      return solvePrime(ns, host, details);
    case MODEL.roman:
      return solveRoman(ns, host, details);
    case MODEL.dog:
      return solveList(ns, host, details, DOG_NAMES);
    case MODEL.guess:
      return solveGuess(ns, host, details);
    case MODEL.common:
      return solveList(ns, host, details, COMMON_PASSWORDS);
    case MODEL.eu:
      return solveList(ns, host, details, EU_COUNTRIES);
    case MODEL.yesnt:
      return solveYesnt(ns, host, details);
    case MODEL.binary:
      return solveBinary(ns, host, details);
    case MODEL.spice:
      return solveCountModel(ns, host, details, "spice");
    case MODEL.base10:
      return solveBase10(ns, host, details);
    case MODEL.expression:
      return solveExpression(ns, host, details);
    case MODEL.divisibility:
      return solveDivisibility(ns, host, details);
    case MODEL.triple:
      return solveTripleModulo(ns, host, details);
    case MODEL.hill:
      return solveHill(ns, host, details);
    case MODEL.sniff:
      return solveSniffer(ns, host, details);
    case MODEL.xor:
      return solveXor(ns, host, details);
    default:
      return fail("unsupported model " + String(model));
  }
}
