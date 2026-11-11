// Shapes shared between tasks and the daemon. Types only → 0 GB.
import type { MoneySource, Task } from "@ns";

export interface Snapshot {
  t: number;
  node: number;
  lastAugReset: number;
  lastNodeReset: number;
  sourceFiles: Record<string, number>;
  augsInstalled: number;
  money: number;
  hackLevel: number;
  hackExp: number;
  karma: number;
  kills: number;
  city: string;
  factions: string[];
  invites: string[];
  rep: Record<string, number>;
  favor: Record<string, number>;
  /** Earnings by source since the last augment install (cumulative). */
  earned: MoneySource;
  work: Task | null;
  homeRam: number;
  homeCores: number;
  gang: null | {
    faction: string;
    respect: number;
    respectRate: number;
    moneyRate: number;
    territory: number;
    members: number;
  };
  sleeves: number;
  /** faction rep multiplier from share() threads running right now (1 = none) */
  shareMult?: number;
}

/** What tasks/graft.js is doing, for the daemon dashboard and diagnostics. */
export interface GraftState {
  t: number;
  aug: string;
  status: "starting" | "grafting" | "done" | "cancelled" | "failed";
  started?: number;
  ended?: number;
  city?: string;
  owned?: boolean;
  error?: string;
}

/** Income categories of MoneySource (everything else is spending). */
export const INCOME_KEYS = [
  "hacking",
  "hacknet",
  "gang",
  "crime",
  "work",
  "stock",
  "corporation",
  "bladeburner",
  "codingcontract",
  "infiltration",
  "sleeves",
  "casino",
] as const satisfies readonly (keyof MoneySource)[];
export type IncomeKey = (typeof INCOME_KEYS)[number];
