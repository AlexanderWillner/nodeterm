# Bun 1.4 migration — branch `chore/bun-migration`

Experimental branch that evaluates replacing Node/npm with Bun 1.4 as package manager,
script runner, and (where possible) runtime. See https://bun.com/blog/bun-v1.4.

## What "replace Node with Bun" means here

**Electron cannot be replaced by Bun.** The desktop app's main process is Electron,
which embeds its own Node runtime (v22 in Electron 42). `node-pty` and `smart-whisper`
are native modules built with `electron-rebuild` against Electron's Node ABI — that
rebuild must still run via `node`/`electron-rebuild`, even when the install was
done with `bun install`. The `Bun` replacement is therefore:

- `npm ci` → `bun install` (fetch + link + lifecycle)
- `npm run <script>` → `bun run <script>` (script runner overhead)
- `node out/server/main.cjs` → `bun out/server/main.cjs` (Server Edition host)
- `node out/session-host/host.cjs` → `bun out/session-host/host.cjs` (session host)

The native rebuild still delegates to `node` (explicit `node scripts/patch-node-pty.mjs`
in `postinstall`/`rebuild`), so a Bun-managed checkout works only while `node`
remains installed for that step — the CI job therefore installs both.

## TL;DR benchmark (Apple Silicon Mac, 8c/25 GB, bun 1.4.0 · node 26.7 · npm 11)

| Task | npm (node) | bun 1.4 | speedup |
|---|---|---|---|
| `install` — clean fetch only (`--ignore-scripts`) | ~42.9 s · 916 MB RSS | ~5.7 s (fetch) + 10 s rebuild | **~2.7×** overall, **~7.5×** fetch |
| `install` — clean with `electron-rebuild` | ~52 s (est., 42 + 10 rebuild) | **15.7 s** · 510 MB RSS | **~2.7×**, 44% less RSS |
| `typecheck` (`tsc` ×2) | 0.58 s · 326 MB | **0.44 s** · 298 MB | **1.32×** |
| `vitest run` (full suite, 668 files) | **67.1 s** · 400 MB | 72.4 s · 400 MB | **0.93×** (slower — 1 extra failure) |
| `electron-vite build` + relay | 15.57 s · 2.53 GB | **13.26 s** | **1.17×** |

`bun install` dominates the win. Script-runner wins are real but small (~0.14 s on
typecheck). `vitest run` under Bun's Node compat is currently **slower and slightly
less compatible** (one extra failure: `localStorage.clear` in `cardModalSize` — Bun's
jsdom/happy-dom shim difference). Re-run with `BENCH_REPEAT=3 BENCH_WARMUP=1` for
stable numbers; install with `BENCH_INSTALL=1`.

Full tables and methodology are in `scripts/bench.mjs` — run:

```bash
node scripts/bench.mjs                        # wall-time only
BENCH_REPEAT=3 BENCH_WARMUP=1 node scripts/bench.mjs
BENCH_INSTALL=1 node scripts/bench.mjs        # includes destructive clean install bench
bun scripts/bench.mjs                         # same via Bun
```

## Changes on this branch vs `main`

- `package.json`:
  - `packageManager: "bun@1.4.0"`, `engines.bun >=1.4.0`, `trustedDependencies` (Bun 1.4
    blocks lifecycle scripts unless trusted).
  - `build` now calls `node scripts/build-codex-relay.mjs` directly instead of
    `npm run build:codex-relay` (removes an npm indirection that cost a child process).
  - Added `test:bun`, `server:build:bun`, `server:start:bun`, `server:dev:bun`,
    `bench`, `bench:bun` helpers that explicitly opt into `bun --bun`.
- `bunfig.toml` — trustedDependencies mirror + `lockfile = "bun.lock"`.
- `bun.lock` committed alongside `package-lock.json` during the experiment.
- `.github/workflows/ci-bun.yml` — parallel CI job that installs both runtimes
  (Bun for fetch/run, Node for `electron-rebuild`) gating the `chore/bun-migration`
  branch.
- `scripts/bench.mjs` — narrow reproducible bench (`/usr/bin/time -l` on macOS).

## Compatibility notes

- `postinstall` / `rebuild` must stay `node` — `electron-rebuild` is Node-only
  (native addon rebuild against Electron's headers).
- `vitest` under `bun --bun` shows a small regression and a `localStorage` incompatibility;
  prefer `bun run test` (which runs vitest via Node compat) for now — tracked for fix.
- Electron Builder packaging (`dist`, `release`) still runs via Node; `bun run dist`
  works (it shells out to `electron-builder` which itself spawns `node`).

## Recommendation

Ship `bun install` as a **supported alternative** (keep `package-lock.json`), do not
yet replace `vitest`'s runtime with `bun --bun`. The 2–3× install win and modest
script-runner win are worth the dual-lockfile cost; the Electron runtime is not
migratable. If the goal is CI minutes, swapping `npm ci` for `bun install` in one
job is the highest-ROI change (≈27 s saved per run on this host vs ≈5 s for the build).

