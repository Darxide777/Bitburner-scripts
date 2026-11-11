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
- pulls telemetry (`data/*.txt` on home) into `./logs/` every minute for offline analysis, and
  appends the new lines of every history log to `./logs/archive/<name>.jsonl`. In-game files
  live in the save (the casino saves before every hand), so they're capped to about a day
  (metrics/sleeves 1500 lines, grafting 200, company 300, traces 500); the archive on disk
  keeps everything, a few MB a day. The analysis tools read the archive when it exists.
- writes a build hash to `build.txt` on home once a build has settled; `daemon.js` notices the
  change and restarts itself and the hack/gang/Go managers on the new code (`tasks/restart.js`)

Compare BitNodes with `node tools/nodes.mjs` (cleared nodes and the current one's milestones)
and individual runs with `node tools/runs.mjs [count]` (duration, income, XP, spend, aug value,
and percent change from the previous run).
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
│   ├─ backdoor.js        connect along the path and install a backdoor (spawned, not awaited)
│   ├─ contracts.js       solve every coding contract on the network (every 5 min)
│   ├─ contracts-selftest.js  every solver vs. the game's dummy contracts, once per build
│   ├─ install.js         buy planned augs → home RAM → NeuroFlux → install, restart daemon
│   ├─ graft.js           travel to New Tokyo, graft one aug, wait for completion
│   └─ destroy.js         destroy w0r1d_d43m0n → next BN12
├─ tmp/call/*.js          generated one-function proxies (see lib/call.ts)
├─ hack/manager.js        long-running HWGW batcher across every rooted server's RAM
│   └─ hack/w/{h,g,w,s}.js  minimal workers (hack/grow/weaken/share)
├─ gang/manager.js        long-running gang manager, ticks on every gang update
├─ stanek/charge.js       one big charging process for Stanek's Gift (spawned after installs)
├─ go/play.js             IPvGO manager: our own MCTS player + matchup picker
├─ corp/manager.js        corporation: Agriculture, investors, dividends (all calls via proxy, SF3)
├─ hacknet/manager.js     hacknet servers: hashes by value, production by payback (~10 GB, SF9)
├─ stocks/manager.js      4S-forecast stock trader, longs + shorts (~37 GB, home ≥ 512 GB)
├─ bladeburner/manager.js Bladeburner: join, skills, city, actions (~73 GB, home ≥ 2048 GB)
├─ infiltrate.js          infiltration autoplayer: reads each minigame's model, trades intel for rep
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
`sleeve.travel`) and `{ share }` costs 2.4 GB. Worst of all, any reference named `document` **or
`window`** costs the 25 GB DOM charge — a metrics field called `window` once made the daemon 33 GB
instead of ~8. Hence the odd names in places (`travelTo`, `hackStatus`, `spanMs`);
`node tools/ram-audit.mjs dist/<script>.js <RamCostGenerator.ts>` catches regressions (the cost
table is in the game's source map, `src/Netscript/RamCostGenerator.ts`).

Faction actions run from the daemon through the call proxy (`lib/act.ts`), so the biggest
recurring task — which sets the home reserve — is `tasks/economy.js` (~20 GB); `contracts.js`
only runs on spare RAM. `data/status.txt` → `ram` shows each task's and home user's actual cost.

**Factions & augments** (`lib/plan/factions.ts`, pure and unit-tested). Every 15 s the daemon
collects faction/aug state and the planner decides:

- *join*: accept invites. A city faction is joined only if its unowned augs are worth more than
  every enemy faction it would lock out.
- *work*: grind the faction whose next aug gives the most value per second of rep. It picks the
  work type with the highest rep/s from Formulas. With nothing left to grind, it builds rep for
  NeuroFlux, then falls back to crime (karma toward a gang).
- *travel / backdoor*: when a wanted faction is missing only a city or a backdoor, go get it.
- *skill gates* (hacking, charisma, combat): a skill level that blocks something valuable — a faction
  invite, the easiest company job in a useful field, or w0r1d_d43m0n's hack level. In BN12 the
  Daedalus hacking-2500 gate starts XP as soon as its actual aug requirement is met
  (30 + 1.02^SF12, capped at 40), even before $100b. Hacking: the manager puts `hackXpShare` (50%) of the pool on weaken for XP, rising to
  `hackXpShareMax` (90%) once money no longer gates Daedalus (weaken gives a hack's XP
  per thread and never touches money) on the server with the most XP per second, until the gate
  clears. Study (player time): XP still needed for the level — the game's skill formula inverted
  with the multiplier calibrated from current level and XP — ÷ the best course's XP/s
  (`formulas.work.universityGains`: Algorithms for hacking, Leadership for charisma; for combat
  stats the best gym by `formulas.work.gymGains`, one stat at a time in a fixed order) gives the
  study time; the gate's value ÷ (study + the rep it then needs) competes with faction work and
  company routes like a company route does (20% margin, or when there's nothing better).
- *company work* (megacorp factions): for factions whose invite needs company rep or a job,
  the route's value per second is the faction's best aug ÷ (company rep still needed at the
  formula rate of the best position you qualify for + that aug's faction rep at your average
  faction-work rate). It replaces faction work only when it beats the best grind by 20%
  (`companyMargin`), or when there's nothing to grind. Applying again while employed is how
  promotions happen, so the job is re-applied for each tick. Every evaluation is logged to
  `data/company.txt` (routes, chosen job, grind score, company data) to judge it.
- *buy*: nothing during a run. Each purchase multiplies remaining prices by 1.9 (×SF11
  discount), so everything is bought at install time, most expensive first (prereqs first).
  Where favor allows, donations cover rep gaps (never at factions without work, e.g.
  Bladeburners and Church of the Machine God, which refuse them). The Red Pill is bought immediately.
- *install*: by the marginal value theorem — once waiting for the best pending aug earns less
  value per second (its value ÷ its ETA) than recent runs earned on average (aug value
  installed ÷ run length over the last 5 runs this BitNode: `data/runs.txt` lengths, valued from the augs each
  install event in `data/events.txt` bought), with at least `minAugsToInstall` new augs. Until 3
  runs can be valued, the old rule: next aug further away than `installPatience` × the run so far.
  Also when the run exceeds `maxRunMs`, or when installing would unlock donations at a faction
  that takes them. In BN12, once Daedalus' actual aug requirement is met, `pushRedPill` (default on)
  suppresses installs until The Red Pill; set it false to keep the normal cadence. The push is
  capped by `pushRedPillMaxMs` (48h) so a stalled XP farm cannot hold the run forever.
  After The Red Pill, `autoDestroy` holds all further installs until w0r1d_d43m0n: an install
  would reset the hack level needed to destroy it. `plan.installRates` shows both rates.
  The final Red Pill install buys The Red Pill first, then spends every remaining dollar
  on NeuroFlux Governor levels; those levels still help the final w0r1d_d43m0n hack. Home
  RAM only gets whatever the NFG price/rep ladder leaves behind, and other ready augs are
  not queued for this install.
- *infra spend*: the economy module's budget tapers from 50% to 5% as install approaches,
  because cloud servers are wiped on install. During the Red Pill push it follows The Red
  Pill's ETA instead of the next aug's, and after The Red Pill it opens to 50% because the
  only remaining goal is the final hack-level grind. In *share-only* mode the planner keeps
  `augReserve` in cash and spends the rest on RAM. During the Red Pill push that reserve is
  The Red Pill's price plus any Daedalus donation for its rep gap, plus the $100b invite until
  Daedalus is joined. Other augs, installs, grafts, sleeve augs, gang equipment, stock-market
  access, hacknet production, corporation creation and NeuroFlux are all held. The economy module reserves 25% for hacknet RAM, then lets any cloud/home
  budget it cannot use (shrinking cloud caps) spill into hacknet too; both are RAM for
  `share()`, while hacknet levels/cores are skipped because they add hashes, not threads.
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
  shrinks as the multiplier grows. Install penalty (v3): an augment install multiplies every
  member's banked ascension points by 0.95 (≈ −2.5% multiplier, since mult = √(points/2000)) but
  leaves unbanked exp alone, so ascending right before an install throws 5% of the new points
  away. Ascensions are held while an install is planned or the expected one (median recent run
  length − time since the last install) is under 10 min (`holdAscendSec`); `data/gang.txt`
  shows each install's projected effect (`installFactor`, from `getInstallResult`).

**Sleeves** (`lib/plan/sleeves.ts`, `lib/sleeves.ts`). Recovery is off by default; enable a
rotation with `"sleeveRecovery": {"slots": 1, "margin": 5, "mode": "rotate"}` when runs are long
enough to pay back shock recovery. In rotation the most-shocked sleeve recovers (it produces
least, so benching it costs least) and hands over once another sleeve is 5 points worse.
With no gang yet, the others commit the crime with the most expected karma per second (karma is
only granted on success: Homicide 3 per 3 s vs Mug 0.25 per 4 s, so Homicide wins above ~6% of
Mug's success chance), which
minimizes time-to-gang. Otherwise each grindable faction gets its best-suited sleeve, including
the faction the player is working for (the game only forbids two sleeves on one faction); then
Bladeburner contracts (one sleeve per contract, ≥70%
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

**Corporation** (`lib/plan/corp.ts` decides, `corp/manager.ts` acts; needs SF3). Every corp
function costs 10–20 GB, so all of them run through the call proxy (peak ~22 GB, which the
daemon keeps free on home). The corp survives installs and resets on a BitNode destroy. It is
created once its $150b is ≤10% of cash (never while the casino bets). Once per corp cycle:
Warehouse/Office API and Smart Supply unlocks → an Agriculture division in all six cities with
warehouses, Smart Supply and Plants/Food sold at MAX/MP → offices staffed to size with a fixed
job split, tea and parties above 95% energy/morale → boost materials (Hardware, Robots, AI
Cores, Real Estate) in the optimal mix for `boostFrac` (50%) of each warehouse — the closed-form
maximum of Π(1 + 0.002·qᵢ)^fᵢ for the space → research (Hi-Tech R&D Lab, Market-TA.I/II, AutoBrew,
AutoPartyManager…) → the cheapest of warehouse/office/corp upgrades/AdVert within 20% of funds →
investment rounds 1–2, each accepted once the corp has been profitable for 20 cycles in a row and
its offer has then stopped growing (<1% over 30 cycles; a 5-cycle window once took round 1 at
$7b ten seconds in, while nothing was producing yet) →
then go public selling no shares and pay dividends.

Phase 2, once Agriculture is in all six cities and funds reach 2× Tobacco's starting cost: a
**Tobacco** product division set up the same way, with Aevum as the development office (job
split weighted to engineering/management) and research-heavy support offices. Products are
developed one at a time in Aevum (1% of funds each for design and marketing, min $1b); with
every slot full, the lowest-rated finished product is retired for the next. Finished products
sell everywhere at MAX/MP, then by Market-TA.II once researched (product research adds
uPgrade: Fulcrum / Capacity.I–II). With the Export unlock, Agriculture's Plants go to Tobacco
in every shared city (`(IPROD+IINV/10)*(-1)`: what the importer uses) and Tobacco's Smart Supply
prefers imports. **Dividends** follow the data: `dividendRate` (10%) while the corp still has
affordable growth purchases, `maxDividendRate` (50%) after `saturatedCycles` (20) cycles without
one. **Bribes**: the game needs a $100t valuation and pays 1 rep per $1b, so only a saturated corp
bribes, with ≤10% of funds per cycle, for the planner's current rep gap.

**Hacknet** (`lib/plan/hacknet.ts` decides, `hacknet/manager.ts` acts; needs SF9). Every hash
upgrade is priced in money-equivalent $ per hash from measured data: Sell for Money ($1m / 4
hashes, the floor); Increase Maximum Money and Reduce Minimum Security on each hacking target
(its $/s from `data/hack.txt` × the gain × the expected rest of the run, the median of recent run
lengths); Sell for Corporation Funds ($1b to the corp, worth to you the corp's return —
profit ÷ valuation — × the dividends you actually receive per $ of profit × (1 − tribute) for the
margin, since dividends are paid as x^(1 − tribute), over 12 h, halved for diminishing returns);
Bladeburner Rank (seconds of progress saved at the measured rank/s, capped at what's
left to Operation Daedalus, × income/s); Generate Coding Contract (average measured money
reward). It buys the best one, saves for it when it beats selling and fits the cache, else
sells; it measures each purchase's real effect and uses that instead of the 2% default.
Production (level/RAM/cores/servers) is bought by payback time — it must pay back within half
the expected rest of the run, since installs wipe hacknet servers — with the planner's infra
share of cash, and not while the casino bets. `data/hacknet.txt` shows the ranked options.
Hacknet servers normally never run scripts (`isHacknet` in `lib/net.ts`): RAM in use lowers
their hash production, and hashes sell for money anyway. In *share-only* mode the hack manager
deliberately borrows their free RAM for `share()`, and the hacknet manager buys RAM upgrades and
new servers instead of levels/cores, trading hashes for faction rep.

**Stocks** (`lib/plan/stocks.ts` decides, `stocks/manager.ts` acts). Buys a WSE account, TIX API
and 4S Market Data TIX API once each costs ≤50% of cash (`stocksAccessBudgetFrac`; `1` buys as soon as affordable; they survive installs), then trades on
every market update: long above a 0.55 forecast, short below 0.45 (SF8.2), best expected return
(|forecast − 0.5| × volatility) first, closing when the forecast crosses 0.5. It keeps the
planner's current infra share (≥10%) in cash and pauses while the casino bets. The planner
counts the portfolio's liquidation value as money; `tasks/install.js` sells everything before
buying augs, since installing wipes positions without paying out.

*Pre-4S* (with just the TIX API, until the 4S API is bought): forecast ≈ share of up-ticks over
the last 20 ticks, volatility ≈ 2 × mean |move|; a short 8-tick window that strongly disagrees
means the trend flipped, and the stock is treated as neutral (closes positions, no entries).
Entries need |forecast − 0.5| ≥ 0.1; stocks without a full window are left alone, and the price
history is saved (`data/stock-history.txt`) so restarts don't need a warm-up. Its closed trades
decide by themselves whether to trade at all. A *shadow trader* paper-trades every stock on the
same signals (entry at the ask, exit at the bid), and real entries are allowed only once it has
≥10 closed trades whose mean return beats both legs' commissions on a typical position, while
the last 10 real pre-4S trades aren't net negative (re-checked every tick, so it can switch on
and off). No new entries when the 4S API is affordable within 15 min (net worth vs. its cost ÷
the configured budget share, at the measured income); once net worth covers it, positions are
sold to buy it.
`"stocks": ...` / `preCfg` tune it; `pre4s: false` in the stock control turns it off.

**Infiltration** (`lib/plan/infiltration.ts` decides, `infiltrate.ts` plays). The game punishes
scripted key presses on purpose (an untrusted keydown hospitalizes you), so no key events are
ever dispatched: the script finds the infiltration object through React's fiber tree and calls
the active minigame model's own `onKey()` with keys computed from that model's state (the
cheat code, the brackets, the grid target, the positive bribe word, the mine layout, which
wires to cut, the backward answer; Slash strikes only while the guard is distracted). Games
are recognised by their fields, not (minified) class names, and a key is never sent once the
stage has moved on. The daemon starts it for the faction the planner is grinding when the best
location's rep/s — measured per location (EMA; dropped once rewards decay below 50% of the
first run), else estimated from `ns.infiltration` — beats that faction's work rep/s by 20%,
and not during the casino or Bladeburner training. Safety: only locations under difficulty 3
(the game's value already accounts for your stats; 3.5 means instant discovery) whose failures
you could survive twice at current HP (3 × starting security each, halved by the WKS harmonizer);
a location is dropped once it has ≥3 attempts and <67% success; after a failed run the daemon
waits 10 min, doubling per failure in a row (max 2 h). While it
runs the daemon leaves work, travel and installs alone. This deliberately bypasses the game's
anti-automation; `"manageInfiltration": false` turns it off.

**Grafting** (`lib/plan/grafting.ts` decides, `tasks/graft.js` grafts; needs SF10). From the
game's source: a grafted aug applies at once and lasts until the BitNode ends, but each graft
adds an Entropy stack that lasts as long — every gain multiplier ×0.98, hacknet costs ÷0.98 —
unless you own The Congruity Implant (grafting it also clears all Entropy). Grafting takes your
time. Every 5 min the daemon values each graftable aug against one Entropy stack and its graft
time, next to the faction route's ETA. It auto-grafts the best row that clears all caps:
`net` = value − one Entropy stack (always positive), net/hour, `maxGraftMs`, `maxEntropy`
(default 3 stacks after the graft), cash after `moneyReserve`, and `onlyIfFaster` versus the
faction route. A faction route ready now is never grafted (it comes with the next install), and
The Red Pill / NeuroFlux are skipped. Grafting is also skipped while installs are held for
The Red Pill, and after The Red Pill when `autoDestroy` is finishing the run: a graft would
pause the Daedalus/hack-level work it is meant to speed up. Until Daedalus is joined in BN12,
the graft price must also leave `$100b` in cash. While a graft runs, work, travel, installs,
casino and infiltration are paused; the task travels to New Tokyo and waits for the game's own
completion signal. The full evaluation is logged to `data/grafting.txt` every 10 min (with the
chosen row and Entropy
before/after), and `data/grafting-state.txt` records the active/last graft. Configure overrides
under `"grafting"`: `auto`, `minNet`, `minNetPerHour`, `maxGraftMs`, `maxEntropy`, `moneyReserve`,
`onlyIfFaster`, `focus`, `skip`.

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
  threads: home's `ramShare` (50%) or a whole cloud server (cores don't count toward highestCharge).
  - *Peak*: `rounds` (5) calls per fragment, ~25 s, whenever the biggest block is ≥2× the
    fragments' highestCharge (install, home upgrades, bigger cloud servers).
  - *Continuous* (otherwise): charges forever on the biggest block that's ≤ `maxPoolShare` (25%)
    of all RAM, because numCharge keeps growing (~1 per full-size call): ×1.01 after 5 rounds,
    ×1.4 after an hour, ×1.75 after a day. Early in a node, home is most of the RAM, so it only
    peak-charges; later one cloud server becomes the dedicated charger (moved when a block ≥1.5×
    appears). `"stanek": {"continuous": false}` restores peak-only.
  - *Church mode*: Church of the Machine God rep comes only from charging (~threads^0.95 per
    call), so while its augs (Stanek's Gift - Awakening, Serenity) are rep-gated, extra
    continuous chargers run on more cloud servers, up to `churchPoolShare` (35%) of all RAM.
    The planner values those augs +3 above their listed stats (`plan.augBonus`).
  RAM is reclaimed from hacking by raising the home reserve or telling the hacking manager to
  skip the chargers' servers. After 5 minutes it starts with whatever ≥25% is free. Status
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
- *Cheats* (SF14.2): a cheat spends our turn; it succeeds with chance p (falling with each
  attempt that game), a failure skips our turn, and after the first attempt a failure ejects us
  (~10%, a loss). Each turn with p ≥ 30% and a normal move that isn't already ≥95% winning, our
  own search values the options — two moves (best move + best follow-up), or removing one stone
  from each of up to 3 enemy chains with ≤2 liberties (opponent to move, via a color-swapped
  search) — and the skipped turn; a cheat is played only if p·V(success) + (1−p)·(1−eject)·V(skip)
  beats the normal move by 0.03. Calls go through the proxy (8 GB each). `data/go.txt` counts
  attempts, successes, ejections and the summed predicted chance, to check the odds.
- *Rotation* (optional): every available opponent gets a 15-minute turn, in weight order
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
faction-working. In the BN12 Red Pill push, once the planner sees every wanted aug is affordable
(no skill gate, Daedalus joined, Red Pill not installed) and only faction rep is left, it switches
to *share-only*: in-flight money workers are killed and the whole hack pool—including hacknet
server RAM—runs 1-round `share()` until money is needed again.

**Telemetry files** (on home, mirrored to `./logs/`):

| file | contents |
| --- | --- |
| `data/status.txt` | latest snapshot + metrics (overwritten each tick) |
| `data/metrics.txt` | JSONL, one line/minute: income/s (+ by source), rep/s per faction, karma/s, time to gang, hack xp/s, RAM pool, and `systems`: Bladeburner rank/rate, gang, Stanek bonuses, corp, stocks, hacknet, skills, sleeve shock |
| `data/events.txt` | JSONL decision log (purchases, roots, resets, errors) |
| `data/runs.txt` | JSONL, one line per augment install / node reset: duration, node elapsed, money/earned/run spend, install spend, hack level/XP/rep start→end and gains, peak income/rep/money, augs bought (+ NeuroFlux), their value/value-per-hour, install reason/rates, and `vsPrev` percent changes from the previous run |
| `data/nodes.txt` | JSONL, one line per cleared BitNode: length, installs (average run length), winning route, every milestone's time, plus total earned/spent, hack XP, peak income/rep/money and earned-by-source totals |
| `data/milestones.txt` | JSONL: first time each milestone happens in a node (casino cap, gang, Bladeburner, Simulacrum, Stanek augs, Daedalus, Red Pill, w0r1d hack level, 4S, corp) |
| `data/hack.txt` | hacking manager status: targets, batches, expected $/s |

## User modules

A slot for your own long-running scripts, run alongside the built-in managers:

1. Copy `src/user/template.ts` to `src/user/<name>.ts` and write your logic (the sync server
   builds and pushes it like everything else).
2. List it in `data/config.txt`: `{"userModules": [{"script": "user/<name>.js", "args": [], "minHomeGB": 0}]}`.

The daemon then starts it whenever it isn't running (with enough home RAM), holds home RAM for
it in the hacking reserve, and `tasks/restart.js` restarts it on every new build. To cooperate:

- read `data/context.txt` (`DaemonContext` in `daemon.ts`) each loop: `uiBusy` (casino.js /
  infiltrate.js own the screen, so don't navigate or change work), `installPlanned`, `money`,
  `homeFree`, `workFaction`, `sinceInstallMs`, …
- write `data/user-reserve.txt` as `{ "hosts": [...] }` to keep the hacking manager off servers
  your module uses
- keep its RAM low by routing expensive API calls through `lib/call.ts`

### Darknet automation

The darknet suite under `src/user/dnet/` is game automation for Bitburner's fictional darknet:
it explores in-game servers, solves the game's generated passwords, propagates helper scripts,
and loots in-game caches. It only calls Bitburner's `ns.dnet`/Singularity APIs inside the
single-player save; it does not touch real networks, hosts, or credentials. To enable it, merge
this into `data/config.txt` (keep any other modules you already have):

```json
{"userModules": [{"script": "user/dnet/manager.js", "args": [], "minHomeGB": 0}]}
```

Alternatively, run `run user/dnet/enable.js` in the terminal; it merges that entry into
`data/config.txt` without replacing your other settings.

The manager starts `setup.js`, which buys the TOR router and DarkscapeNavigator.exe (requires
SF4 Singularity access), and refreshes `user/dnet/charisma.txt`. It reserves `darkweb` plus
every host in `user/dnet/passwords.json` in `data/user-reserve.txt`, and pauses while the
daemon reports `uiBusy` or `installPlanned`. Generated state stays in `user/dnet/` on home:
`passwords.json`, `charisma.txt`, the fixed `snap.json` snapshot, and a `rewards.txt` ledger of
opened caches.

## Roadmap

- [x] Tooling: TS build, Remote API sync with type refresh + telemetry pull
- [x] Telemetry + metrics: income/s, rep/s, karma/s, time to gang, rep/money ETAs, per-run summaries
- [x] Rooting, HWGW batch manager, faction `share()`
- [x] Economy: TOR/programs, home RAM/cores, cloud servers
- [x] Factions & augments: invites with city conflicts, travel, backdoors, rep-grind choice,
      escalation-aware purchase order, donations, NeuroFlux, install timing, w0r1d_d43m0n
- [x] Install timing learned from run history (marginal value of waiting vs. recent runs' average)
- [x] Casino: blackjack save-scumming for $10b per install
- [x] Stanek's Gift: acceptance, layout solver, per-install charging
- [x] IPvGO: rules engine, MCTS player, self-optimizing matchup choice
- [x] Company work → megacorp factions, when the route beats faction work (logged to judge it)
- [x] Skill gates: hacking-XP farming, study (hacking/charisma) and gym (combat) when a level blocks a faction,
      a company job, or w0r1d_d43m0n
- [x] Shrink the home reserve: daemon 33 → ~8 GB (`window` DOM charge), faction actions via the
      proxy (34 GB task gone), contracts on spare RAM, corp proxy reserve only with a corp
- [x] Sleeves: karma for the gang, then one per grind faction; shock recovery; sleeve augs
- [x] Gang: creation, recruit, equipment, training, respect/money mode, wanted control,
      territory warfare, ascension
- [x] Grafting: per-aug value vs. Entropy and time, logged every 10 min
- [x] Grafting: autoplay when net/hour clears time, cash and cumulative-Entropy caps
- [x] Gang: v3 install penalty — hold ascensions before installs, report the projected loss
- [x] Hacknet servers: data-priced hash spending, payback-based production
- [ ] Hacknet: value SP, gym/study and company favor
- [x] Bladeburner: join (after Stanek), skills, city, stamina/chaos control, contracts/ops/black ops
- [x] Bladeburner first: gym training to join early, Operation Daedalus as a win condition
- [x] Sleeves on Bladeburner contracts; shock-recovery rotation + experiment telemetry
- [ ] Sleeves: pick recovery slots from the measured break-even instead of a fixed count
- [x] Coding contracts: all 30 types, per-build self-test against the game
- [x] Stock market: 4S forecasts, longs + shorts, liquidation before install
- [x] Stock market: pre-4S trading from price history, self-disabling on a losing record
- [x] Corporation: Agriculture, boost materials, research, investment rounds, dividends
- [x] Corporation phase 2: Tobacco products, Plants exports, data-driven dividends, bribes
- [x] Infiltration: model-reading autoplayer, rep-per-second trigger vs. faction work
- [x] IPvGO cheats (SF14.2): played when their search-valued EV beats the normal move
- [x] Endgame: Daedalus → The Red Pill → w0r1d_d43m0n, then auto-continue into the next BN12 level
