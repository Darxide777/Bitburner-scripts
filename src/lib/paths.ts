// Shared file names and constants. Pure data → 0 GB.

export const DATA = {
  config: "data/config.txt", // planner tunables (daemon-level)
  hackConfig: "data/hack-config.txt", // tunables for hack/manager.js, written by the daemon
  status: "data/status.txt", // latest full status snapshot (overwritten)
  metrics: "data/metrics.txt", // JSONL time series (one line per minute)
  events: "data/events.txt", // JSONL decision/event log
  runs: "data/runs.txt", // JSONL one line per augment install / node reset
  hackStatus: "data/hack.txt", // hacking manager status
  gang: "data/gang.txt", // gang manager status
  gangConfig: "data/gang-config.txt", // gang tunables, written by the daemon
  casino: "data/casino.txt", // casino.js outcome for the current install
  go: "data/go.txt", // IPvGO manager status
  goConfig: "data/go-config.txt", // IPvGO tunables
  contracts: "data/contracts.txt", // coding contracts: totals + ones we failed (never retried)
  contractsSelftest: "data/contracts-selftest.txt", // per-build check of every solver on dummy contracts
  installContext: "data/install-context.txt", // the daemon's view of the install it just started (rates, aug values)
  lastInstall: "data/last-install.txt", // what tasks/install.js actually bought (kept: not capped like events)
  destroyContext: "data/destroy-context.txt", // which route ended the BitNode
  milestones: "data/milestones.txt", // JSONL: first time each milestone happens in a BitNode
  nodes: "data/nodes.txt", // JSONL: one line per cleared BitNode
  context: "data/context.txt", // daemon context for user modules (overwritten every tick)
  userReserve: "data/user-reserve.txt", // { hosts: [...] } user modules want the hacking manager to leave alone
  dnet: "data/dnet.txt", // darknet manager status
  company: "data/company.txt", // JSONL: company routes vs. faction grind (megacorp invites)
  grafting: "data/grafting.txt", // JSONL every 10 min: graftable augs valued vs. entropy and time
  graftingState: "data/grafting-state.txt", // what tasks/graft.js is doing (active graft / last result)
  infiltration: "data/infiltration.txt", // infiltration runs: measured rep/s per location
  infiltrationConfig: "data/infiltration-config.txt", // infiltration control, written by the daemon
  corp: "data/corp.txt", // corporation manager status
  corpConfig: "data/corp-config.txt", // corporation control, written by the daemon
  hacknet: "data/hacknet.txt", // hacknet manager status (options, decision, measured effects)
  hacknetConfig: "data/hacknet-config.txt", // hacknet control, written by the daemon
  sleeves: "data/sleeves.txt", // JSONL per minute: sleeve shock/task/predicted rep (shock experiment)
  stocks: "data/stocks.txt", // stock manager status (portfolio value counts as money)
  stocksConfig: "data/stocks-config.txt", // stock control, written by the daemon
  bladeburner: "data/bladeburner.txt", // Bladeburner manager status
  bladeburnerConfig: "data/bladeburner-config.txt", // Bladeburner control, written by the daemon
} as const;

export const SCRIPTS = {
  daemon: "daemon.js",
  restart: "tasks/restart.js",
  hackManager: "hack/manager.js",
  gangManager: "gang/manager.js",
  casino: "casino.js", // launcher (small)
  goManager: "go/play.js",
  bladeburnerManager: "bladeburner/manager.js",
  stocksManager: "stocks/manager.js",
  hacknetManager: "hacknet/manager.js",
  corpManager: "corp/manager.js",
  infiltrate: "infiltrate.js",
  graft: "tasks/graft.js", // travel to New Tokyo, graft one aug, wait for it
  casinoTable: "casino/table.js", // the DOM-driving script (~36 GB)
  hackScript: "hack/w/h.js",
  growScript: "hack/w/g.js",
  weakenScript: "hack/w/w.js",
  shareScript: "hack/w/s.js",
} as const;

/** Hash of the current build, written by tools/sync.mjs; daemon.js restarts when it changes. */
export const BUILD_MARKER = "build.txt";

/**
 * The BitNode's final server (note the underscore). It only joins the network once
 * The Red Pill is installed; rooting/collection also address it by name in case no
 * scan() path reaches it.
 */
export const WORLD_DAEMON = "w0r1d_d43m0n";

export const TASK_DIR = "tmp/task";

/** Karma needed to create a gang outside BitNode 2. */
export const GANG_KARMA = -54000;
