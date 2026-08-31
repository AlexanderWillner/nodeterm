#!/usr/bin/env node
/**
 * bench.mjs — reproducible micro-benchmarks for the bun migration branch.
 *
 * Measures wall time and (on macOS) peak RSS via /usr/bin/time -l.
 * Run with either runtime:
 *   node scripts/bench.mjs          # via Node
 *   bun scripts/bench.mjs           # via Bun  — both time the SAME subprocesses
 * or via npm/bun scripts:
 *   npm run bench / bun run bench
 *
 * The bench is intentionally narrow: install / typecheck / vitest / electron-vite build.
 * Electron itself can't be replaced by Bun (it embeds Node); the win is in
 * package-manager + script-runner + server/host runtime overhead.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPEAT = Number(process.env.BENCH_REPEAT ?? 1);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 0);

function run(cmd, args, opts = {}) {
  const t0 = performance.now();
  const res = spawnSync(cmd, args, {
    stdio: "pipe",
    encoding: "utf8",
    ...opts,
  });
  const dt = performance.now() - t0;
  return { dt, status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Run via macOS /usr/bin/time -l if available, else plain wall time. */
function timeL(cmd, args) {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/time")) {
    const r = run("/usr/bin/time", ["-l", cmd, ...args]);
    // Parse "X.XX real" and "maximum resident set size"
    let real = null;
    let rss = null;
    const mReal = r.stderr.match(/([\d.]+)\s+real/);
    if (mReal) real = parseFloat(mReal[1]);
    const mRss = r.stderr.match(/(\d+)\s+maximum resident set size/);
    if (mRss) rss = parseInt(mRss[1], 10);
    return { real, rss, dt: r.dt, stderr: r.stderr };
  }
  const r = run(cmd, args);
  return { real: r.dt / 1000, rss: null, dt: r.dt, stderr: r.stderr };
}

function fmtMs(ms) {
  return `${ms.toFixed(0)} ms`;
}
function fmtRss(bytes) {
  if (bytes == null) return "—";
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

const tasks = [
  {
    id: "typecheck",
    label: "tsc --noEmit (2 projects)",
    npm: ["npm", "run", "typecheck"],
    bun: ["bun", "run", "typecheck"],
  },
  {
    id: "test",
    label: "vitest run (full suite)",
    npm: ["npm", "test", "--silent"],
    bun: ["bun", "run", "test", "--silent"],
  },
  {
    id: "build",
    label: "electron-vite build + codex-relay",
    npm: ["npm", "run", "build", "--silent"],
    bun: ["bun", "run", "build", "--silent"],
  },
  {
    id: "server-build",
    label: "esbuild server bundle",
    npm: ["npm", "run", "server:build", "--silent"],
    bun: ["bun", "run", "server:build", "--silent"],
  },
];

let rows = [];
for (const t of tasks) {
  for (let w = 0; w < WARMUP; w++) {
    run(t.npm[0], t.npm.slice(1));
    run(t.bun[0], t.bun.slice(1));
  }
  let npmTimes = [];
  let bunTimes = [];
  let npmRss = null;
  let bunRss = null;
  for (let i = 0; i < REPEAT; i++) {
    const a = timeL(t.npm[0], t.npm.slice(1));
    npmTimes.push((a.real ?? a.dt / 1000) * 1000);
    npmRss = a.rss ?? npmRss;
    const b = timeL(t.bun[0], t.bun.slice(1));
    bunTimes.push((b.real ?? b.dt / 1000) * 1000);
    bunRss = b.rss ?? bunRss;
  }
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const npmAvg = avg(npmTimes);
  const bunAvg = avg(bunTimes);
  const speedup = npmAvg / bunAvg;
  rows.push({
    task: t.id,
    label: t.label,
    npmMs: npmAvg,
    bunMs: bunAvg,
    speedup,
    npmRss,
    bunRss,
  });
  console.log(
    `${t.label}: npm ${fmtMs(npmAvg)} (${fmtRss(npmRss)}) vs bun ${fmtMs(bunAvg)} (${fmtRss(bunRss)}) → ${speedup.toFixed(2)}×`
  );
}

// Install benchmark (destructive — only when BENCH_INSTALL=1)
if (process.env.BENCH_INSTALL === "1") {
  console.log("\n--- install benchmark (BENCH_INSTALL=1) ---");
  console.log("This moves node_modules aside, runs `npm ci` and `bun install` clean, then restores.");
  const hasLock = fs.existsSync("package-lock.json");
  const hasBunLock = fs.existsSync("bun.lock");
  if (!hasLock || !hasBunLock) {
    console.log("Skipping: need both package-lock.json and bun.lock");
  } else {
    const nmExists = fs.existsSync("node_modules");
    // bench npm ci clean (ignore-scripts to isolate fetch)
    if (nmExists) fs.renameSync("node_modules", "node_modules.bench.bak");
    fs.rmSync("node_modules", { recursive: true, force: true });
    let a = timeL("npm", ["ci", "--ignore-scripts", "--silent"]);
    console.log(`npm ci --ignore-scripts: ${(a.real ?? a.dt / 1000).toFixed(2)}s rss ${fmtRss(a.rss)}`);
    fs.rmSync("node_modules", { recursive: true, force: true });
    let b = timeL("bun", ["install", "--ignore-scripts", "--silent"]);
    console.log(`bun install --ignore-scripts: ${(b.real ?? b.dt / 1000).toFixed(2)}s rss ${fmtRss(b.rss)}`);
    fs.rmSync("node_modules", { recursive: true, force: true });
    if (fs.existsSync("node_modules.bench.bak")) fs.renameSync("node_modules.bench.bak", "node_modules");
    console.log(`install speedup (fetch only): ${((a.real ?? a.dt / 1000) / (b.real ?? b.dt / 1000)).toFixed(2)}×`);

    // With rebuild
    if (fs.existsSync("node_modules")) fs.renameSync("node_modules", "node_modules.bench.bak2");
    fs.rmSync("node_modules", { recursive: true, force: true });
    a = timeL("npm", ["ci", "--silent"]);
    console.log(`npm ci (with rebuild): ${(a.real ?? a.dt / 1000).toFixed(2)}s rss ${fmtRss(a.rss)}`);
    fs.rmSync("node_modules", { recursive: true, force: true });
    b = timeL("bun", ["install", "--silent"]);
    console.log(`bun install (with rebuild): ${(b.real ?? b.dt / 1000).toFixed(2)}s rss ${fmtRss(b.rss)}`);
    fs.rmSync("node_modules", { recursive: true, force: true });
    if (fs.existsSync("node_modules.bench.bak2")) fs.renameSync("node_modules.bench.bak2", "node_modules");
  }
}

console.log("\nDone. Repeat with BENCH_REPEAT=3 BENCH_WARMUP=1 for stable numbers.");
console.log("For install numbers use: BENCH_INSTALL=1 node scripts/bench.mjs");
if (rows.length) {
  const line = rows.map((r) => `${r.task}: ${r.speedup.toFixed(2)}×`).join(" | ");
  console.log(`Summary speedups: ${line}`);
}
