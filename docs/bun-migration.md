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

Full tables and methodology are in `scripts/bench.mjs` and `scripts/bench-runtime.mjs` — run:

```bash
node scripts/bench.mjs                        # wall-time only (typecheck/build)
BENCH_REPEAT=3 BENCH_WARMUP=1 node scripts/bench.mjs
BENCH_INSTALL=1 node scripts/bench.mjs        # includes destructive clean install bench
bun scripts/bench.mjs                         # same via Bun

node scripts/bench-runtime.mjs                # Laufzeit: Server RSS/CPU/Throughput
BENCH_REQUESTS=1000 node scripts/bench-runtime.mjs
```

## Laufzeit: Server & Host (Node vs Bun)

Electron-Desktop kann nicht auf Bun umgestellt werden (embeddet Node). Gemessen wurde die **Server Edition** (`out/server/main.cjs`) und der **Session-Host** (`out/session-host/host.cjs`) — die beiden reinen Node-Prozesse, die Bun tatsächlich ersetzen kann. Jeweils `node <bundle>` vs `bun <bundle>`, 500–1000 HTTP-Requests (401-Pfad) gegen frischen Temp-`dataDir`, `ps -o rss` für RSS, `fetch`-Loop für Latenz/RPS. Host: MacBook Air M2, 8c/24 GB, bun 1.4.0 (34cbb9a), node 26.7.0, gemessen 31.08.2026.

| Prozess | Node | Bun | Delta |
|---|---|---|---|
| **Server — idle RSS** | ~70 MB | ~46 MB | **−34 %** (Bun) |
| **Server — load RSS** (nach 500–1000 Requests) | ~78–80 MB | ~55–61 MB | **−28 %** (Bun) |
| **Server — Start bis listening** | ~98–120 ms | ~71–92 ms | **−20 %** (Bun, streut stark) |
| **Server — RPS / avg Latenz** (500–1000× `GET /` → 401) | ~3800–5800 rps / 0.17–0.39 ms | ~4200–8300 rps / 0.12–0.23 ms | **kein robuster Unterschied** — Streuung 30–50 % auf dem Laptop, im Mittel ±10 %, mal Node schneller, mal Bun. CPU-lastige Pfade zeigen keinen belastbaren Gewinn. |
| **Session-Host — idle RSS** (`/tmp/...` dataDir) | ~56 MB | ~31 MB | **−45 %** (Bun) |
| **Electron Main** (Desktop) | — | — | **unverändert** — läuft immer auf Electrons eigenem Node (v22), nicht ersetzbar |

Methodik: `scripts/bench-runtime.mjs` spawnt `node|bun out/server/main.cjs --port 0 --data-dir <tmp>`, wartet auf `listening on http 127.0.0.1:<port>`, macht `BENCH_REQUESTS` fetches (Warmup 20), misst RSS vor/nach via `ps`, vergleicht 3 Läufe. Einzelwerte oben sind Roh-RSS; `time -l` Peak-RSS für den Host-Prozess selbst ist nicht sinnvoll (kurzlebig), daher `ps` im Live-Prozess.

Fazit Laufzeit: **Weniger RAM ja (−30 % Server, −45 % Host) — weniger CPU nein.** Für die Server Edition auf einem kleinen VPS (1 GB) ist der RAM-Gewinn relevant (ca. 25 MB pro Instanz plus ~25 MB pro Host). CPU/Durchsatz ist auf diesem IO-lastigen 401-Pfad nicht signifikant — wer CPU spart, muss woanders suchen (z. B. `bun --bun` für CPU-Knoten wie `tsc` bringt dort 1.3×, `vitest` aber 0.93×). Der größte Hebel bleibt `bun install` in CI.

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
yet replace `vitest`'s runtime with `bun --bun`. The 2–3× install win, ~30 % weniger RSS in der Laufzeit und modest
script-runner win sind den Dual-Lockfile-Preis wert; die Electron-Runtime ist nicht
migratable, und CPU bleibt gleich. If the goal is CI minutes, swapping `npm ci` for `bun install` in one
job is the highest-ROI change (≈27 s saved per run on this host vs ≈5 s for the build); für kleine Server ist der RAM-Gewinn der zweite Hebel.

