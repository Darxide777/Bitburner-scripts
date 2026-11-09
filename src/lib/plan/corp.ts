// Corporation decisions. Pure logic → 0 GB; corp/manager.ts gathers data and acts.

export const CITIES = ["Aevum", "Chongqing", "Ishima", "New Tokyo", "Sector-12", "Volhaven"] as const;
export const JOBS = ["Operations", "Engineer", "Business", "Management", "Research & Development"] as const;
export type Job = (typeof JOBS)[number];

export interface CorpConfig {
  /** create the corp once its $150b costs at most this share of cash */
  createCashFrac: number;
  /** most of corp funds one purchase may take */
  budgetFrac: number;
  /** warehouse share filled with boost materials (the rest is for production) */
  boostFrac: number;
  /** upgrade a warehouse above this fill */
  warehouseFull: number;
  /** job split for material industries (fractions, normalised) */
  jobs: Record<Job, number>;
  /** accept investment rounds up to this one, once the offer has plateaued */
  maxRound: number;
  /** offer counts as plateaued when its growth over `plateauCycles` is below this */
  plateauGrowth: number;
  plateauCycles: number;
  /**
   * and only after this many profitable cycles in a row: right after creation the offer is
   * flat because nothing produces yet (round 1 was once taken at $7b, 10 s in)
   */
  minProfitCycles: number;
  /** dividend rate once public while the corp still has growth to buy… */
  dividendRate: number;
  /** …and once it's saturated (no affordable growth purchase for `saturatedCycles` cycles) */
  maxDividendRate: number;
  saturatedCycles: number;
  /** product division: start once funds ≥ this × its starting cost */
  productStartMult: number;
  /** design and marketing investment per new product, as a share of funds (min $1b each) */
  productInvestFrac: number;
  /** job split for the product development city, and for the support (research) cities */
  devJobs: Record<Job, number>;
  rdJobs: Record<Job, number>;
  /** bribes: share of funds per cycle, only when saturated and valuation ≥ the game's threshold */
  bribeFrac: number;
  /** keep energy / morale above this fraction of their max */
  minEnergy: number;
  minMorale: number;
}

export const DEFAULT_CORP: CorpConfig = {
  createCashFrac: 0.1,
  budgetFrac: 0.2,
  boostFrac: 0.5,
  warehouseFull: 0.7,
  jobs: { Operations: 0.25, Engineer: 0.25, Business: 0.15, Management: 0.2, "Research & Development": 0.15 },
  maxRound: 2,
  plateauGrowth: 0.01,
  plateauCycles: 30,
  minProfitCycles: 20,
  dividendRate: 0.1,
  maxDividendRate: 0.5,
  saturatedCycles: 20,
  productStartMult: 2,
  productInvestFrac: 0.01,
  devJobs: { Operations: 0.25, Engineer: 0.3, Business: 0.1, Management: 0.25, "Research & Development": 0.1 },
  rdJobs: { Operations: 0.15, Engineer: 0.15, Business: 0.05, Management: 0.15, "Research & Development": 0.5 },
  bribeFrac: 0.1,
  minEnergy: 0.95,
  minMorale: 0.95,
};

export interface BoostMaterial {
  name: string;
  /** industry factor (e.g. realEstateFactor) */
  factor: number;
  /** warehouse space per unit */
  size: number;
}

/**
 * Optimal boost-material amounts for `space` warehouse units. A city's production multiplier
 * is Π (1 + 0.002·qᵢ)^fᵢ, so maximise Σ fᵢ·ln(1 + 0.002·qᵢ) subject to Σ sᵢ·qᵢ = space:
 * Lagrange gives qᵢ = fᵢ·(space + 500·Σs) / (sᵢ·Σf) − 500; materials that come out negative
 * are dropped and the rest re-solved.
 */
export function optimalBoost(mats: BoostMaterial[], space: number): Record<string, number> {
  let use = mats.filter((m) => m.factor > 0 && m.size > 0);
  for (;;) {
    const sumF = use.reduce((a, m) => a + m.factor, 0);
    const sumS = use.reduce((a, m) => a + m.size, 0);
    if (!use.length || sumF <= 0) return Object.fromEntries(mats.map((m) => [m.name, 0]));
    const q = use.map((m) => (m.factor * (space + 500 * sumS)) / (m.size * sumF) - 500);
    const neg = q.findIndex((x) => x < 0);
    if (neg < 0) {
      const out: Record<string, number> = Object.fromEntries(mats.map((m) => [m.name, 0]));
      use.forEach((m, i) => (out[m.name] = Math.floor(q[i])));
      return out;
    }
    use = use.filter((_, i) => i !== neg);
  }
}

/** Integer job counts for `n` employees (largest remainder; ≥1 in each job once n ≥ jobs). */
export function splitJobs(n: number, ratios: Record<Job, number>): Record<Job, number> {
  const total = JOBS.reduce((a, j) => a + (ratios[j] ?? 0), 0) || 1;
  const out = Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<Job, number>;
  if (n <= 0) return out;
  let left = n;
  if (n >= JOBS.length)
    for (const j of JOBS) {
      out[j] = 1;
      left--;
    }
  const exact = JOBS.map((j) => ((ratios[j] ?? 0) / total) * left);
  JOBS.forEach((j, i) => (out[j] += Math.floor(exact[i])));
  let rest = n - JOBS.reduce((a, j) => a + out[j], 0);
  const order = JOBS.map((j, i) => [j, exact[i] - Math.floor(exact[i])] as const).sort((a, b) => b[1] - a[1]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][0]]++;
  return out;
}

/**
 * Accept an investment round once its offer has stopped growing: over the last
 * `plateauCycles` samples it grew less than `plateauGrowth` in total.
 */
export function offerPlateaued(history: number[], cfg: CorpConfig = DEFAULT_CORP): boolean {
  if (history.length < cfg.plateauCycles + 1) return false;
  const recent = history.slice(-(cfg.plateauCycles + 1));
  const first = recent[0];
  const last = recent[recent.length - 1];
  return first > 0 && last > 0 && (last - first) / first < cfg.plateauGrowth;
}

/** Research to buy in order, each once its cost is at most half the division's points. */
export const RESEARCH_ORDER = ["Hi-Tech R&D Laboratory", "Market-TA.I", "Market-TA.II", "AutoBrew", "AutoPartyManager", "Automatic Drug Administration", "Go-Juice", "CPH4 Injections", "Overclock", "Sti.mu"];

/** Corp-wide upgrades worth buying for a material division, cheapest first within budget. */
export const UPGRADES = ["Smart Factories", "Smart Storage", "Wilson Analytics", "ABC SalesBots", "Nuoptimal Nootropic Injector Implants", "Speech Processor Implants", "Neural Accelerators", "FocusWires", "Project Insight"];

export interface Purchase {
  what: string;
  cost: number;
}

/** The cheapest affordable purchase within budget, or null. */
export function cheapest(options: Purchase[], budget: number): Purchase | null {
  const ok = options.filter((o) => Number.isFinite(o.cost) && o.cost > 0 && o.cost <= budget).sort((a, b) => a.cost - b.cost);
  return ok[0] ?? null;
}

// ---------- product division (phase 2) ----------

/** Products are designed in this city; its office gets the development job split. */
export const DEV_CITY = "Aevum";
/** Extra research for product divisions (after the shared order). */
export const PRODUCT_RESEARCH = ["uPgrade: Fulcrum", "uPgrade: Capacity.I", "uPgrade: Capacity.II"];
/** Plants from Agriculture feed Tobacco: export what the importer uses (+ a tenth of its stock). */
export const EXPORT_AMOUNT = "(IPROD+IINV/10)*(-1)";

export interface ProductInfo {
  name: string;
  progress: number;
  rating: number;
}

/**
 * Product pipeline: wait while one is in development; with a free slot make the next;
 * with all slots full, discontinue the lowest-rated finished one first.
 */
export function productStep(
  products: ProductInfo[],
  maxProducts: number,
  prefix: string,
): { kind: "wait" } | { kind: "make"; name: string; discontinue?: string } {
  if (products.some((p) => p.progress < 100)) return { kind: "wait" };
  const nums = products.map((p) => Number(p.name.slice(prefix.length))).filter(Number.isFinite);
  const name = `${prefix}${(nums.length ? Math.max(...nums) : 0) + 1}`;
  if (products.length < maxProducts) return { kind: "make", name };
  const worst = [...products].sort((a, b) => a.rating - b.rating)[0];
  return { kind: "make", name, discontinue: worst.name };
}

/** Dividend rate: low while there's growth to buy, high once the corp is saturated. */
export function dividendFor(cyclesWithoutGrowth: number, cfg: CorpConfig = DEFAULT_CORP): number {
  return cyclesWithoutGrowth >= cfg.saturatedCycles ? cfg.maxDividendRate : cfg.dividendRate;
}

/**
 * Bribe for a faction's rep gap with idle funds: only when saturated and the valuation clears
 * the game's threshold; at most bribeFrac of funds; 0 = don't.
 */
export function bribeAmount(
  repGap: number,
  funds: number,
  valuation: number,
  cyclesWithoutGrowth: number,
  constants: { bribeThreshold: number; bribeAmountPerReputation: number },
  cfg: CorpConfig = DEFAULT_CORP,
): number {
  if (repGap <= 0 || valuation < constants.bribeThreshold || cyclesWithoutGrowth < cfg.saturatedCycles) return 0;
  return Math.max(0, Math.min(repGap * constants.bribeAmountPerReputation, funds * cfg.bribeFrac));
}
