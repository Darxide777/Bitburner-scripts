# Bitburner-scripts

Automation script for Bitburner. Only works if you have everything unlocked and are playing bitnode 12 on repeat.

Self-optimizing, full-game automation for [Bitburner](https://github.com/bitburner-official/bitburner-src),
written from scratch in TypeScript. Target: the infinite BitNode (BN12) with all Source-Files owned.

The goal is a single `run daemon.js` that plays the whole game: it tracks every system, measures
rates (income/s, rep/s, karma/s, …), and steers toward the fastest path to destroying the BitNode,
which mid-game usually means maximizing **faction reputation** throughput.

## Setup

```sh
npm install
npm run dev        # tsc --watch + Remote API sync server on ws://localhost:12525
```

In game: **Options → Remote API**, set port `12525`, press **Connect**. Every compiled file is
pushed to `home`, and changes are pushed on save. Then in the terminal:

```
run daemon.js
```

While connected, the sync server also:

- refreshes `types/NetscriptDefinitions.d.ts` from the running game, so the types match your game version
- pulls telemetry (`data/*.txt` on home) into `./logs/` every minute for offline analysis

Other commands: `npm run build`, `npm run typecheck`, `npm run sync` (sync without the tsc watcher).

## Architecture

```
daemon.js                 orchestrator: telemetry → metrics → planner modules → dashboard
├─ tasks/*.js             short-lived scripts for RAM-expensive APIs (Singularity, Gang, …)
│   ├─ snapshot.js        one-shot telemetry probe (player, money sources, rep, karma, gang…)
│   └─ economy.js         TOR, port openers, home RAM/cores, cloud servers
└─ hack/manager.js        long-running HWGW batcher across every rooted server's RAM
    └─ hack/w/{h,g,w,s}.js  minimal workers (hack/grow/weaken/share)
lib/                      shared code: task runner, metrics, network, file IO, formatting
```

**RAM model.** A Bitburner script costs the sum of every API function it references, so the
daemon stays small and runs expensive calls as *tasks*: temporary scripts that write a JSON result
to a file and exit (`lib/task.ts`). Each task only holds RAM for milliseconds.

**Hacking.** "Shotgun" HWGW: a target is only attacked from a prepped state (min security,
max money). All batches for a cycle are exec'd in one synchronous burst, so the Formulas
timings are exact, and `additionalMsec` makes each batch land H→W→G→W. Several targets run
concurrently, ranked by $ per GB·s. Leftover RAM is lent to factions via `share()` while
faction-working.

**Telemetry files** (on home, mirrored to `./logs/`):

| file | contents |
| --- | --- |
| `data/status.txt` | latest snapshot + metrics (overwritten each tick) |
| `data/metrics.txt` | JSONL, one line/minute: income/s (+ by source), rep/s per faction, karma/s, time to gang, hack xp/s, RAM pool, … |
| `data/events.txt` | JSONL decision log (purchases, roots, resets, errors) |
| `data/runs.txt` | JSONL, one line per augment install / node reset: duration, peak income, peak rep/s |
| `data/hack.txt` | hacking manager status: targets, batches, expected $/s |

## Roadmap

- [x] Tooling: TS build, Remote API sync with type refresh + telemetry pull
- [x] Telemetry + metrics: income/s, rep/s, karma/s, time to gang, rep/money ETAs, per-run summaries
- [x] Rooting, HWGW batch manager, faction `share()`
- [x] Economy: TOR/programs, home RAM/cores, cloud servers
- [ ] **Factions & augments**: invites (with city-faction conflicts), backdoors, choosing what to
      work for, buying augs in optimal order (price ×1.9 escalation), NeuroFlux, install timing
- [ ] **Install planner**: reset when the marginal value of waiting drops below the value of
      installing (driven by `runs.txt` history)
- [ ] Sleeves: shock recovery → sync → karma for the gang → faction/company work
- [ ] Crime/karma path to a gang; gang manager (recruit, tasks, equipment, ascension, territory)
- [ ] Hacknet servers + hash spending
- [ ] Bladeburner (alternate win condition + rep)
- [ ] Corporation, Stanek's Gift, IPvGO, coding contracts, stock market
- [ ] Endgame: Daedalus → The Red Pill → w0r1dd43m0n, then auto-continue into the next BN12 level
