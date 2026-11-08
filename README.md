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

Other commands: `npm run build`, `npm run typecheck`, `npm test` (planner unit tests),
`npm run sync` (sync without the tsc watcher), and
`node tools/ram-audit.mjs dist/<script>.js <RamCostGenerator.ts>`, an offline estimate of a
script's RAM that flags identifiers colliding with API names (see "RAM model").

## Architecture

```
daemon.js                 orchestrator: telemetry → metrics → planner modules → dashboard
├─ tasks/*.js             short-lived scripts for RAM-expensive APIs (Singularity, Gang, …)
│   ├─ snapshot.js        one-shot telemetry probe (player, money sources, rep, karma, gang…)
│   ├─ economy.js         TOR, port openers, home RAM/cores, cloud servers
│   ├─ factions-act.js    join / travel / work / crime / buy The Red Pill
│   ├─ backdoor.js        connect along the path and install a backdoor (spawned, not awaited)
│   ├─ install.js         buy planned augs → home RAM → NeuroFlux → install, restart daemon
│   └─ destroy.js         destroy w0r1dd43m0n → next BN12
├─ tmp/call/*.js          generated one-function proxies (see lib/call.ts)
└─ hack/manager.js        long-running HWGW batcher across every rooted server's RAM
    └─ hack/w/{h,g,w,s}.js  minimal workers (hack/grow/weaken/share)
lib/                      task runner, call proxy, metrics, network, file IO, formatting
lib/plan/                 faction/aug data collection, requirement evaluator, planner
```

**RAM model.** A Bitburner script costs the sum of every API function it references, so the
daemon stays small (~5 GB) and runs expensive calls elsewhere:

- *tasks*: temporary scripts that write a JSON result to a file and exit (`lib/task.ts`).
- *call proxy* (`lib/call.ts`): for data collection, a generated script per API function that
  maps one function over many arguments, so peak RAM is 1.6 GB + one function. The faction scan
  touches ~20 Singularity functions but never needs more than ~7 GB at once.

The game's RAM calculator charges for any identifier, including property names, that matches
an API function name anywhere in the script's import tree. So `x.travel` costs 4 GB (it matches
`sleeve.travel`) and `{ share }` costs 2.4 GB. Hence the odd names in places (`travelTo`,
`hackStatus`); `tools/ram-audit.mjs` catches regressions.

**Factions & augments** (`lib/plan/factions.ts`, pure and unit-tested). Every 15 s the daemon
collects faction/aug state and the planner decides:

- *join*: accept invites. A city faction is joined only if its unowned augs are worth more than
  every enemy faction it would lock out.
- *work*: grind the faction whose next aug gives the most value per second of rep. It picks the
  work type with the highest rep/s from Formulas. With nothing left to grind, it builds rep for
  NeuroFlux, then falls back to crime (karma toward a gang).
- *travel / backdoor*: when a wanted faction is missing only a city or a backdoor, go get it.
- *buy*: nothing during a run. Each purchase multiplies remaining prices by 1.9 (×SF11
  discount), so everything is bought at install time, most expensive first (prereqs first).
  Where favor allows, donations cover rep gaps. The Red Pill is bought immediately.
- *install*: when the next valuable aug is further away than `installPatience` × the time
  since the last install (with at least `minAugsToInstall` new augs), when the run exceeds
  `maxRunMs`, or when installing would unlock donations at a faction with augs left. Leftover
  money goes to home RAM, then NeuroFlux levels.
- *infra spend*: the economy module's budget tapers from 50% to 5% as install approaches,
  because cloud servers are wiped on install.
- *destroy*: with The Red Pill installed and the hack level reached, destroy w0r1dd43m0n
  and start the next BN12.

Tune it in `data/config.txt`, e.g. `{"plan": {"installPatience": 0.4, "weights": {"faction_rep": 5}}}`.

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
- [x] Factions & augments: invites with city conflicts, travel, backdoors, rep-grind choice,
      escalation-aware purchase order, donations, NeuroFlux, install timing, w0r1dd43m0n
- [ ] Learn install timing from `runs.txt` history instead of fixed `installPatience`
- [ ] Company work → megacorp factions (ECorp, MegaCorp, KuaiGong, NWO, …)
- [ ] Hacking-XP mode when the hack level gates the next faction or w0r1dd43m0n
- [ ] Move the remaining recurring tasks onto the call proxy to shrink the home reserve
- [ ] Sleeves: shock recovery → sync → karma for the gang → faction/company work
- [ ] Crime/karma path to a gang; gang manager (recruit, tasks, equipment, ascension, territory)
- [ ] Hacknet servers + hash spending
- [ ] Bladeburner (alternate win condition + rep)
- [ ] Corporation, Stanek's Gift, IPvGO, coding contracts, stock market
- [ ] Endgame: Daedalus → The Red Pill → w0r1dd43m0n, then auto-continue into the next BN12 level
