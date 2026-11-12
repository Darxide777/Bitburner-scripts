# Bitburner Scripts — Agent Guidelines

## Project overview
Self-optimizing full-game automation for Bitburner. Written from scratch in TypeScript, compiled to JavaScript for the game's Netscript sandbox.

## Language and tooling
- **TypeScript** (strict mode, ES2022 target, ESNext modules)
- **Build**: `tsc -p .` (src → dist). Scripts deployed to the game via `tools/sync.mjs`
- **Path alias**: `@ns` → `types/NetscriptDefinitions.d.ts` (custom Bitburner API types)
- **No runtime dependencies** — only devDependencies (typescript, ws) for build/tooling
- All `ns` functions are **async** — always `await ns.xxx(...)`

## Architecture

### Task/daemon split
- **Daemon** (`daemon.js`): long-running orchestrator, manages state, makes decisions
- **Tasks** (`tasks/*.ts`): short-lived scripts that make expensive API calls, return results via JSON files
- **Workers** (`hack/w/*.ts`, `gang/manager.ts`, etc.): specialized managers for specific subsystems
- **Lib** (`lib/*.ts`): shared utilities (I/O, networking, call proxy, planning)

### RAM is the critical resource
- Every `ns` function reference adds ~1.6 GB to a script's RAM cost
- Tasks pay only for the functions they reference, not the daemon's full cost
- **The `call` proxy** (`lib/call.ts`) generates per-function proxy scripts to avoid referencing many singularity functions in one script (~6.6 GB peak vs ~34 GB for a monolithic task)
- Types-only files cost **0 GB** — keep types in separate files when possible

### File-based IPC
- `ns.read()` / `ns.write()` cost 0 GB — use for all inter-script communication
- JSON state lives under `data/*.txt` (config, status, metrics, events)
- Task outputs go to `tmp/task/*.txt`
- Log files under `data/*.txt` are trimmed in-game; synced to `logs/` by `tools/sync.mjs`

## Coding conventions

### Structure
- Constants at top: `const MAX_BATCHES = 400;`
- Interfaces before implementations
- `export async function main(ns: NS): Promise<void>` as entry point
- Config-driven: read from `data/*.txt`, not hardcoded
- Use `SCRIPTS` and `DATA` constants from `paths.ts` — never hardcode file/script names

### Error handling
- Envelope pattern: `{ ok: boolean, value?: T, error?: string }` for task results
- Try/catch around all network/singularity calls
- Log with `ns.tprint()` for visibility, `ns.print()` for structured output
- `CallError` for proxy failures (RAM not available, timeout)

### State management
- `readJson<T>(ns, file, fallback)` / `writeJson(ns, file, value)` for JSON state
- `appendJsonl()` / `appendLines()` for time-series logs with line limits
- Maps/Sets → plain JSON via `replacer()` (the game returns `Map`/`Set` objects)

### Concurrency
- `ns.exec(script, host, { threads: N, temporary: true }, ...args)` for tasks
- `ns.isRunning(pid)` + `ns.kill(pid)` for process management
- `temporary: true` for one-shot scripts (auto-cleaned)
- Batch operations: use synchronous bursts so the game can't change state between steps
- `ns.wake()` before `ns.sleep()` in persistent scripts to prevent sleep from being killed

### Anti-patterns
- **Never hardcode** script names, file paths, or thresholds — use constants from `paths.ts`
- **Never** reference many singularity functions in one script — use the `call` proxy
- **Never** use `sleep()` without `ns.wake()` in persistent scripts
- **Never** assume a host exists or is rooted — always check with `ns.hasRootAccess()` / `ns.fileExists()`
- **Never** use `require()` or `import` outside the project's module system
- **Don't** spawn redundant processes — check `ns.isRunning()` / `ns.ps()` before exec
- **Don't** hardcode sleep times — calculate based on game formulas (Formulas.exe)

### Naming
- Snake_case for config keys and file names: `homeReserve`, `hack-config.txt`
- camelCase for variables and functions
- PascalCase for interfaces and types
- UPPER_SNAKE for constants: `MAX_BATCHES`, `GANG_KARMA`

### Planning
- Planner files in `lib/plan/*.ts` — one per subsystem
- `lib/types.ts` — shared shapes between tasks and daemon (0 GB cost)
- `lib/act.ts` — cheap action execution through the call proxy
- `lib/io.ts` — file I/O utilities
- `lib/net.ts` — network discovery, rooting, BFS traversal

## Subsystem overview
| Directory | Purpose |
|-----------|---------|
| `hack/` | HWGW hacking manager (RAM-optimized batch scheduling) |
| `tasks/` | Short-lived tasks (install, graft, backdoor, cleanup, economy, etc.) |
| `lib/plan/` | Decision/planning logic for each subsystem |
| `lib/` | Shared utilities (I/O, call proxy, types, paths, networking) |
| `corp/` | Corporation management |
| `gang/` | Gang management |
| `hacknet/` | Hacknet node management |
| `stocks/` | Stock market management |
| `bladeburner/` | Bladeburner management |
| `casino/` | Casino automation |
| `go/` | IPvGO automation |
| `infiltrate.ts` | Infiltration (government buildings) |
| `daemon.ts` | Main orchestrator |
| `user/dnet/` | Darknet (user/custom modules) |

## Rules for every change
- **One task per session, one task per commit.** Take one item from the "To do" list in
  `README.md`, finish it, commit it, and stop. Start a new session for the next item.
- **Change only what the task names.** No drive-by refactors, renames or reformatting.
- **Find code by its text, not by line number.** Line numbers in the to-do list drift.
- **If the code does not match the task description, stop and report it.** Do not guess.
- **Check your assumption before you build on it.** If a fix depends on how an `ns` function
  behaves, read its entry in `types/NetscriptDefinitions.d.ts` first.
- **The commit message describes only what this commit changes.** Do not list work from
  earlier commits.
- **Tests must pass before every commit.** A pre-commit hook runs `npm test` and blocks the
  commit if it fails; CI runs the same on GitHub. Never use `git commit --no-verify`.
- **Never edit a test to make it pass** unless the task is to change that test. The one
  exception: when you fix a call listed in `ALLOWED` in `test/conventions.test.mjs`, delete
  its entry there in the same commit.

## Pitfalls (each of these has already broken the project)

### `ns.isRunning` / `ns.kill` by name need the script's arguments
`ns.isRunning(script, host)` and `ns.kill(script, host)` only match a process that was started
with **no arguments**. For a script started with arguments they return `false` and do nothing,
without an error.
- Every task started with `runTask` or `spawnTask` has arguments (the result file is the first).
- Workers (`hack/w/*`), `infiltrate.js`, the Stanek charger and the darknet roamer/lab have
  arguments too.
- Use one of: the pid (`ns.isRunning(pid)`, `ns.kill(pid)`), the same arguments
  (`ns.isRunning(script, host, ...args)`), or `ns.ps(host).some((p) => p.filename === script)`.
- Checked by `test/conventions.test.mjs`.

### Status files are not logs
`data/hack.txt`, `gang.txt`, `stocks.txt`, `corp.txt`, `hacknet.txt`, `bladeburner.txt`,
`go.txt`, `dnet.txt` and every other file read with `readJson` hold **one JSON object**.
- Write them with `writeJson` only.
- Never append to them (`appendJsonl`, `appendLines`, or a wrapper): `readJson` cannot parse a
  multi-line file and silently returns its fallback, so the daemon and the other managers see
  empty status.
- If you want history, append to a **separate** file and leave the status file alone.
- Checked by `test/conventions.test.mjs`.

### Reading a JSON-lines log
One line can be half-written. Parse each line inside `try { … } catch { }` and skip bad lines;
an unprotected `JSON.parse` in a manager's main loop kills the manager.

## Testing
- Build: `npm run build` (runs `tsc -p .`)
- Typecheck: `npm run typecheck`
- Full test: `npm run test` (builds + runs `test/*.test.mjs`)
- Sync to game: `npm run sync`
- Conventions: `test/conventions.test.mjs` reads `src/` as text and enforces the pitfalls above
- Hook: `.githooks/pre-commit` runs `npm test`; `npm install` enables it (`core.hooksPath`)
- CI: `.github/workflows/ci.yml` runs typecheck and tests on every push and pull request

## Common Bitburner API patterns
- Server names: `"home"`, `"n00dles"`, `"w0r1d_d43m0n"` (string literals)
- RAM pool management: track free GB per host, split across hosts for placement
- Formulas.exe: use `ns.formulas.hacking.*` for precise timing/calculation when available
- Fallbacks: always have non-Formulas paths for when Formulas.exe isn't installed yet
- `ns.disableLog("ALL")` at script start to reduce log overhead
- `ns.args` for script arguments: `[outFile, ...userArgs]`
