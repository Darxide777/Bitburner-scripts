// Shared file names and constants. Pure data → 0 GB.

export const DATA = {
  config: "data/config.txt", // planner tunables (daemon-level)
  hackConfig: "data/hack-config.txt", // tunables for hack/manager.js, written by the daemon
  status: "data/status.txt", // latest full status snapshot (overwritten)
  metrics: "data/metrics.txt", // JSONL time series (one line per minute)
  events: "data/events.txt", // JSONL decision/event log
  runs: "data/runs.txt", // JSONL one line per augment install / node reset
  hack: "data/hack.txt", // hacking manager status
} as const;

export const SCRIPTS = {
  daemon: "daemon.js",
  hackManager: "hack/manager.js",
  hack: "hack/w/h.js",
  grow: "hack/w/g.js",
  weaken: "hack/w/w.js",
  share: "hack/w/s.js",
} as const;

export const TASK_DIR = "tmp/task";

/** Karma needed to create a gang outside BitNode 2. */
export const GANG_KARMA = -54000;
