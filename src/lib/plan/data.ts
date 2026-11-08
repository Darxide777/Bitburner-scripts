// Data shapes produced by lib/plan/collect.ts. Types only → 0 GB.
import type { PlayerRequirement } from "@ns";

export interface AugInfo {
  price: number; // current price (already includes this run's escalation)
  repReq: number;
  prereqs: string[];
  factions: string[];
  /** Multipliers that differ from 1 (e.g. { faction_rep: 1.1 }). */
  stats: Record<string, number>;
}

export interface FactionInfo {
  joined: boolean;
  invited: boolean;
  rep: number;
  favor: number;
  favorGain: number;
  enemies: string[];
  workTypes: string[];
  /** Best work type and its rep/s at current stats (focused). */
  bestWork: string | null;
  workRepPerSec: number;
  augs: string[];
  requirements: PlayerRequirement[];
}

export interface FactionData {
  t: number;
  money: number;
  hackLevel: number;
  skills: Record<string, number>;
  karma: number;
  kills: number;
  city: string;
  node: number;
  sourceFiles: Record<string, number>;
  installed: string[];
  queued: string[];
  favorToDonate: number;
  /** Rep gained per $ donated (at current multipliers). */
  repPerDollar: number;
  /** Multiplier applied to all remaining aug prices per purchase (1.9 × SF11 discount). */
  priceMult: number;
  hasNeuroreceptor: boolean;
  gangFaction: string | null;
  files: string[];
  backdoors: Record<string, boolean>;
  /** Hosts with root access whose backdoor could be installed now (required hack level met). */
  backdoorable: string[];
  factions: Record<string, FactionInfo>;
  augs: Record<string, AugInfo>;
  /** company -> job title */
  jobs: Record<string, string>;
  /** w0r1dd43m0n status (only present after The Red Pill is installed). */
  worldDaemon: { exists: boolean; rooted: boolean; reqHack: number };
}

export const NFG = "NeuroFlux Governor";
export const RED_PILL = "The Red Pill";
export const NEURORECEPTOR = "Neuroreceptor Management Implant";
/** Factions whose augs need things we can't script (infiltration). */
export const SKIP_FACTIONS = ["Shadows of Anarchy"];
