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
- writes a build hash to `build.txt` on home once a build has settled; `daemon.js` notices the
  change and restarts itself and the hack/gang/Go managers on the new code (`tasks/restart.js`)

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
│   ├─ contracts.js       solve every coding contract on the network (every 5 min)
│   ├─ contracts-selftest.js  every solver vs. the game's dummy contracts, once per build
│   ├─ install.js         buy planned augs → home RAM → NeuroFlux → install, restart daemon
│   └─ destroy.js         destroy w0r1d_d43m0n → next BN12
├─ tmp/call/*.js          generated one-function proxies (see lib/call.ts)
├─ hack/manager.js        long-running HWGW batcher across every rooted server's RAM
│   └─ hack/w/{h,g,w,s}.js  minimal workers (hack/grow/weaken/share)
├─ gang/manager.js        long-running gang manager, ticks on every gang update
├─ stanek/charge.js       one big charging process for Stanek's Gift (spawned after installs)
├─ go/play.js             IPvGO manager: our own MCTS player + matchup picker
├─ stocks/manager.js      4S-forecast stock trader, longs + shorts (~37 GB, home ≥ 512 GB)
├─ bladeburner/manager.js Bladeburner: join, skills, city, actions (~73 GB, home ≥ 512 GB)
└─ casino.js              blackjack save-scummer for the casino's $10b-per-install allowance
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
- *destroy*: with The Red Pill installed and the hack level reached, destroy w0r1d_d43m0n
  and start the next BN12.

**Gang** (`lib/plan/gang.ts` decides, `gang/manager.ts` acts). At -54k karma the daemon creates
the gang in the joined gang faction with the most valuable unowned augs. Every gang update:

- recruits, and buys equipment cheapest-first: 1% of money per item, 5% for augmentations,
  which survive ascension
- trains members below a stat floor
- puts a share of the strongest members on Territory Warfare until territory is 100%, and only
  engages clashes once every remaining clash is ≥60% likely to be won
- assigns everyone else the best task for the mode: **respect**, which becomes gang-faction rep,
  while that faction still gates augs, otherwise **money**
- cools down the least valuable workers when the wanted penalty passes 3%
- ascends at most one member per update, once their multiplier gain clears a threshold that
  shrinks as the multiplier grows

**Sleeves** (`lib/plan/sleeves.ts`, `lib/sleeves.ts`). One recovery slot rotates by shock: the
most-shocked sleeve recovers (it produces least, so benching it costs least) and hands over once
another sleeve is 5 points worse (`"sleeveRecovery": {"slots", "margin", "mode": "rotate"|"spare"|"off"}`).
With no gang yet, the others commit Homicide (Mug while Homicide would mostly fail), which
minimizes time-to-gang. Otherwise each grindable faction gets its best-suited sleeve, never the
faction the player is working for; then Bladeburner contracts (one sleeve per contract, ≥70%
success) while in the division with black ops left; then favor building; leftovers do crime.
Cheap sleeve augs are bought as shock reaches 0.

Whether early shock recovery pays is measured, not assumed: `data/sleeves.txt` logs every
sleeve's shock/task each minute with predicted vs. observed faction rep, and
`node tools/sleeve-shock.mjs` reports recovery vs. passive decay, shock resets at installs,
whether shock actually scales rep (the game documents it only for exp), and the break-even.

**Bladeburner** (`lib/plan/bladeburner.ts` decides, `bladeburner/manager.ts` acts). Bladeburners
rep only comes from rank, so the planner never plans donations there. With SF7.3, joining the
division grants The Blade's Simulacrum, which blocks accepting Stanek's Gift for the rest of the
BitNode, so the daemon only lets the manager join once the gift is accepted (or impossible).
Joining needs all combat stats at 100: with `plan.bladeburnerFirst` (default on) the player trains
the weakest one at Powerhouse Gym before any faction grind, and the daemon joins the division
itself the moment the stats allow (the manager needs home ≥ 512 GB). With the Simulacrum, actions run alongside faction work;
without it they get the player only when there's no rep-gated aug to grind (ahead of NeuroFlux
and crime). Each update:

- rest in the Hyperbolic Regeneration Chamber below 55% stamina (success halves under 50%) until 95%
- Diplomacy while city chaos is above 50; Field Analysis while success estimates are ±2.5% or worse
- the next Black Op once rank allows it at ≥95% success, Operation Daedalus included: it is a
  second win condition. Once every Black Op is done the daemon destroys the BitNode, whichever
  route gets there first (`"bladeburner": {"allowFinalBlackOp": false}` turns it off). The dashboard
  and `data/bladeburner.txt` show rank/s and the ETA to Daedalus's rank to compare the routes
- otherwise the contract/operation with the most expected rank/s (≥70% contracts, ≥80% ops;
  Raid and Stealth Retirement skipped), without abandoning an action halfway
- skills bought greedily by weight per point; moves to the city with the largest estimated population

**Stocks** (`lib/plan/stocks.ts` decides, `stocks/manager.ts` acts). Buys a WSE account, TIX API
and 4S Market Data TIX API once each costs ≤20% of cash (they survive installs), then trades on
every market update: long above a 0.55 forecast, short below 0.45 (SF8.2), best expected return
(|forecast − 0.5| × volatility) first, closing when the forecast crosses 0.5. It keeps the
planner's current infra share (≥10%) in cash and pauses while the casino bets. The planner
counts the portfolio's liquidation value as money; `tasks/install.js` sells everything before
buying augs, since installing wipes positions without paying out. No pre-4S (price-history)
trading yet.

**Coding contracts** (`lib/contracts.ts`, pure and unit-tested). All 30 contract types have a
solver; Hamming codes and LZ compression follow the game's own algorithms, since answers must
match its format/length. Every 5 minutes `tasks/contracts.js` (~22 GB) solves what it finds on
the network. A contract answered wrong is never retried (a broken solver would burn its tries)
and is listed in `data/contracts.txt`. After every new build the daemon runs a self-test that
creates a dummy of each type and submits it; `data/contracts-selftest.txt` lists failures with
the game's description and data.

**Stanek's Gift** (`lib/plan/stanek.ts` solves, `lib/stanek.ts` manages). From the game's source,
a fragment's bonus is `ln(highestCharge+1)/60 · ((numCharge+1)/5)^0.07 · power · boost`, where
`highestCharge` is the most threads (× core bonus) used in **one** charge call and `boost` is the
product of the powers of every booster touching it. Consequences:

- **Layout** maximizes Σ weight × power × boost. The solver mirrors the game's rotation and
  neighbor geometry. It starts greedy, then runs simulated annealing with 64 seeded restarts
  (~1 s, within ~1% of much bigger searches) and a hill-climb polish. Default weights favor
  Rep, then Hacking, Hacking Speed and Hacking Money. Installs keep the layout but wipe charges,
  so a better layout is only applied when the board is empty or uncharged.
- **Charging** has two modes, one process at a time, on the server with the most effective
  threads: home's `ramShare` (50%) with its core bonus, or a whole cloud server.
  - *Peak*: `rounds` (5) calls per fragment, ~25 s, whenever the biggest block is ≥2× the
    fragments' highestCharge (install, home upgrades, bigger cloud servers).
  - *Continuous* (otherwise): charges forever on the biggest block that's ≤ `maxPoolShare` (25%)
    of all RAM, because numCharge keeps growing (~1 per full-size call): ×1.01 after 5 rounds,
    ×1.4 after an hour, ×1.75 after a day. Early in a node, home is most of the RAM, so it only
    peak-charges; later one cloud server becomes the dedicated charger (moved when a block ≥1.5×
    appears). `"stanek": {"continuous": false}` restores peak-only.
  RAM is reclaimed from hacking by raising the home reserve or telling the hacking manager to
  skip the charger's server. After 5 minutes it starts with whatever ≥25% is free. Status
  shows each fragment's highestCharge and numCharge.
- **Acceptance**: the gift can only be accepted before any non-NeuroFlux aug, so the daemon
  accepts it at BitNode start, before anything can buy augs.

**IPvGO** (`lib/go/engine.ts`, `lib/go/mcts.ts`, `lib/plan/go.ts`, `go/play.ts`). Every finished
game, win or lose (a loss counts half), adds node power for that opponent, and node power
becomes a bonus: Daedalus → rep, Illuminati → hack speed, The Black Hand → hacking money,
`????????????` → hacking level, … Bonuses reset on every install; favor from win streaks at
joined factions does not.

- *Engine*: the game's rules, written from scratch: captures, no suicide, positional superko
  against the game's own move history, area scoring without dead-stone removal, komi.
- *Player*: UCT Monte Carlo tree search with tactical playouts (take captures, don't fill own
  eyes, avoid self-atari). The reward is win/loss plus a little area, because node power scales
  with points. Thinking is sliced (`ns.sleep(0)`) so the UI stays responsive. Offline
  (`node tools/go-bench.mjs 7 6 300 5.5`) it beats a tactical bot every game at ~8.5k
  playouts/move on 7×7.
- *Rotation* (default): every available opponent gets a 15-minute turn, in weight order
  (Daedalus first), so every bonus grows instead of one. `data/go.txt` shows whose turn it is.
- *Matchup picker*: tracks each (opponent, size) arm as an EMA of bonus-points gained per game
  and minutes per game. In rotation it picks the board size for the current opponent; with
  `"go": {"rotateMs": 0}` it picks the arm with the best weighted bonus per minute overall,
  with UCB exploration (weights favor Daedalus, rep).

**Casino** (`casino.ts`). The casino has no API, so this drives the blackjack UI through the DOM
(25 GB while it runs). Loop: save → play a hand with basic strategy → on a loss, reload the
page, which restores the save and restarts the script. Bets are min($100m, money). It stops
when casino winnings since the last install reach $10b; past that the casino only bans you.
The cap resets every install. The daemon starts it automatically when the allowance is
unclaimed and normal income would take >30 min to make $10b (start of a BitNode). While it
runs, the daemon leaves work, travel, and installs alone so the table stays on screen.
Turn it off with `"casino": false`.

Tune it in `data/config.txt`, e.g. `{"plan": {"installPatience": 0.4, "weights": {"faction_rep": 5}}}`.
Other keys: `"manageSleeves"`, `"manageGang"` (booleans), and `"gang"` (overrides for `DEFAULT_GANG`;
setting `"mode"` there pins it).

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
      escalation-aware purchase order, donations, NeuroFlux, install timing, w0r1d_d43m0n
- [ ] Learn install timing from `runs.txt` history instead of fixed `installPatience`
- [x] Casino: blackjack save-scumming for $10b per install
- [x] Stanek's Gift: acceptance, layout solver, per-install charging
- [x] IPvGO: rules engine, MCTS player, self-optimizing matchup choice
- [ ] Company work → megacorp factions (ECorp, MegaCorp, KuaiGong, NWO, …)
- [ ] Hacking-XP mode when the hack level gates the next faction or w0r1d_d43m0n
- [ ] Move the remaining recurring tasks onto the call proxy to shrink the home reserve
- [x] Sleeves: karma for the gang, then one per grind faction; shock recovery; sleeve augs
- [x] Gang: creation, recruit, equipment, training, respect/money mode, wanted control,
      territory warfare, ascension
- [ ] Gang: account for v3's install penalty on ascension multipliers (`getInstallResult`)
- [ ] Hacknet servers + hash spending
- [x] Bladeburner: join (after Stanek), skills, city, stamina/chaos control, contracts/ops/black ops
- [x] Bladeburner first: gym training to join early, Operation Daedalus as a win condition
- [x] Sleeves on Bladeburner contracts; shock-recovery rotation + experiment telemetry
- [ ] Sleeves: pick recovery slots from the measured break-even instead of a fixed count
- [x] Coding contracts: all 30 types, per-build self-test against the game
- [x] Stock market: 4S forecasts, longs + shorts, liquidation before install
- [ ] Stock market: pre-4S trading from price history
- [ ] Corporation
- [ ] IPvGO cheats (SF14 `ns.go.cheat`) where the success chance is worth the risk
- [ ] Endgame: Daedalus → The Red Pill → w0r1d_d43m0n, then auto-continue into the next BN12 level
