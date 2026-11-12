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

## Testing
- Build: `npm run build` (runs `tsc -p .`)
- Typecheck: `npm run typecheck`
- Full test: `npm run test` (builds + runs `test/*.test.mjs`)
- Sync to game: `npm run sync`

## Common Bitburner API patterns
- Server names: `"home"`, `"n00dles"`, `"w0r1d_d43m0n"` (string literals)
- RAM pool management: track free GB per host, split across hosts for placement
- Formulas.exe: use `ns.formulas.hacking.*` for precise timing/calculation when available
- Fallbacks: always have non-Formulas paths for when Formulas.exe isn't installed yet
- `ns.disableLog("ALL")` at script start to reduce log overhead
- `ns.args` for script arguments: `[outFile, ...userArgs]`
