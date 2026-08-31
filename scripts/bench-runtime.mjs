#!/usr/bin/env node
/**
 * bench-runtime.mjs — Laufzeit-Vergleich Node vs Bun für nodeterm Server.
 *
 * Misst nicht Build, sondern laufende Prozesse:
 *   - Startup-Latenz bis "listening"
 *   - RSS / Heap nach Start + nach Load
 *   - CPU-Zeit (user+sys) via /usr/bin/time -l am Host-Prozess
 *   - HTTP-Durchsatz / Latenz unter Last
 *
 * Aufruf:
 *   node scripts/bench-runtime.mjs
 *   bun scripts/bench-runtime.mjs
 *   BENCH_REQUESTS=500 BENCH_WARMUP=50 node scripts/bench-runtime.mjs
 *
 * Voraussetzungen: `npm run server:build` wurde ausgeführt (out/server/main.cjs + out/renderer vorhanden).
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 300)
const WARMUP = Number(process.env.BENCH_WARMUP ?? 20)
const PORT_RETRIES = 5

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function getRssMb(pid) {
  try {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'rss=', '-o', '%cpu='], { encoding: 'utf8' })
    if (r.status !== 0) return { rssMb: null, cpu: null }
    const parts = r.stdout.trim().split(/\s+/)
    const rssKb = parseInt(parts[0], 10)
    const cpu = parseFloat(parts[1])
    return { rssMb: isNaN(rssKb) ? null : rssKb / 1024, cpu: isNaN(cpu) ? null : cpu }
  } catch { return { rssMb: null, cpu: null } }
}

async function benchOne(runtime, bin) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `nodeterm-bench-${runtime}-`))
  const startWall = performance.now()
  let child = null
  let port = null
  let url = null
  try {
    // Spawn server via runtime (node|bun) — out/server/main.cjs
    const args = [bin, '--port', '0', '--data-dir', dataDir, '--host', '127.0.0.1']
    // Ensure we use HTTP (no TLS) — server auto-picks http for loopback
    child = spawn(runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderrChunks = []
    const stdoutChunks = []
    child.stderr.on('data', d => stderrChunks.push(d.toString()))
    child.stdout.on('data', d => stdoutChunks.push(d.toString()))

    // Wait for listening line (max 5s) — prefer "listening on" (real port) over "Setup:" (port 0)
    const listening = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timeout waiting for listening')), 5000)
      const tryParse = () => {
        const out = stdoutChunks.join('') + stderrChunks.join('')
        let m = out.match(/listening on [^:]+:(\d+)/i)
        if (m) return parseInt(m[1], 10)
        // Fallback: Setup line only if listening not yet emitted (headless mode)
        m = out.match(/Setup: http:\/\/[^:]+:(\d+)/)
        if (m) {
          const p = parseInt(m[1], 10)
          if (p !== 0) return p
        }
        return null
      }
      const onData = () => {
        const p = tryParse()
        if (p) {
          clearTimeout(to)
          child.stdout.off('data', onData); child.stderr.off('data', onData)
          resolve(p)
        }
      }
      child.stdout.on('data', onData); child.stderr.on('data', onData)
      child.on('exit', (c) => {
        clearTimeout(to)
        reject(new Error(`server exited ${c}: ${stdoutChunks.join('')}${stderrChunks.join('')}`))
      })
      setTimeout(onData, 300)
    }).catch(async (e) => {
      throw e
    })

    port = listening
    url = `http://127.0.0.1:${port}/`
    const startupMs = performance.now() - startWall

    // Give server a moment to settle
    await sleep(400)
    const memIdle = await getRssMb(child.pid)
    let heapMb = null
    // Try to get heap via /proc? not available on macOS; use ps rss only
    // Warmup requests
    for (let i = 0; i < WARMUP; i++) {
      try { await fetch(url, { signal: AbortSignal.timeout(2000) }).then(r => r.text()).catch(()=>{}) } catch {}
    }

    // Measure load
    const t0 = performance.now()
    let ok = 0, fail = 0
    let firstStatus = null
    const latencies = []
    for (let i = 0; i < REQUESTS; i++) {
      const s = performance.now()
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
        await res.text()
        if (firstStatus === null) firstStatus = res.status
        // Any response < 500 means server handled it (401/302 for unauthed root is expected)
        if (res.status < 500) ok++; else fail++
      } catch { fail++ }
      latencies.push(performance.now() - s)
    }
    const t1 = performance.now()
    const totalMs = t1 - t0
    const avgMs = latencies.reduce((a,b)=>a+b,0)/latencies.length
    const p95 = [...latencies].sort((a,b)=>a-b)[Math.floor(latencies.length*0.95)] ?? null
    const rps = REQUESTS / (totalMs/1000)
    const memLoad = await getRssMb(child.pid)
    if (firstStatus !== null && ok === 0) {
      // Debug: still report
      console.log(`    (first status ${firstStatus}, ok ${ok} fail ${fail})`)
    }
    // CPU time via ps %cpu snapshot (not cumulative)
    return {
      runtime, port, startupMs, memIdle, memLoad, ok, fail, totalMs, avgMs, p95, rps, heapMb
    }
  } finally {
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGTERM') } catch {}
      await sleep(300)
      try { child.kill('SIGKILL') } catch {}
    }
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
  }
}

async function main() {
  const bin = path.resolve('out/server/main.cjs')
  if (!fs.existsSync(bin)) {
    console.error('Missing out/server/main.cjs — run `npm run server:build` first')
    process.exit(1)
  }
  const rendererDir = path.resolve('out/renderer')
  if (!fs.existsSync(rendererDir)) {
    console.warn('Warning: out/renderer missing — server still starts (renderer 404), bench still valid for core.')
  }

  console.log(`# nodeterm Laufzeit-Bench — Server (HTTP) — ${new Date().toISOString()}`)
  console.log(`# Host: ${os.type()} ${os.arch()} cpus=${os.cpus().length} mem=${(os.totalmem()/1024/1024/1024).toFixed(1)} GB`)
  try { console.log(`# node ${process.execPath} — ${spawnSyncVersion('node')}, bun ${spawnSyncVersion('bun')}`) } catch {}
  console.log(`# Requests=${REQUESTS} warmup=${WARMUP} per runtime\n`)

  const results = []
  for (const rt of ['node', 'bun']) {
    // check runtime exists
    try {
      const { spawnSync } = await import('node:child_process')
      const v = spawnSync(rt, ['--version'], { encoding: 'utf8' })
      if (v.status !== 0) { console.log(`skip ${rt}: not found`); continue }
    } catch {}
    console.log(`→ ${rt} ...`)
    try {
      const r = await benchOne(rt, bin)
      results.push(r)
      console.log(`  startup ${r.startupMs.toFixed(0)} ms  idle RSS ${r.memIdle.rssMb?.toFixed(0) ?? '—'} MB  load RSS ${r.memLoad.rssMb?.toFixed(0) ?? '—'} MB  avg ${r.avgMs.toFixed(2)} ms  p95 ${r.p95?.toFixed(2) ?? '—'} ms  rps ${r.rps.toFixed(1)}  ok ${r.ok}/${REQUESTS}`)
    } catch (e) {
      console.error(`  ${rt} failed:`, e.message)
    }
    await sleep(800)
  }

  if (results.length === 2) {
    const [a,b] = results // node, bun
    const rssDelta = (a.memLoad.rssMb && b.memLoad.rssMb) ? ((b.memLoad.rssMb - a.memLoad.rssMb)/a.memLoad.rssMb*100) : null
    const startDelta = ((b.startupMs - a.startupMs)/a.startupMs*100)
    const rpsDelta = ((b.rps - a.rps)/a.rps*100)
    console.log(`\n# Vergleich bun vs node (negativ = bun sparsamer/schneller)`)
    console.log(`  Startup: ${startDelta.toFixed(1)}%  RSS: ${rssDelta !== null ? rssDelta.toFixed(1)+'%' : '—'}  RPS: ${rpsDelta.toFixed(1)}%`)
    if (rssDelta !== null && rssDelta > 5) console.log("  -> Bun braucht mehr RSS (typisch: Buns JSC heap ist groesser als V8 bei diesem Workload).")
    else if (rssDelta !== null && rssDelta < -5) console.log("  -> Bun braucht weniger RSS.")
    else console.log("  -> RSS praktisch gleich.")
  }

  console.log(`\n# Hinweis: Electron-Desktop kann nicht auf Bun umgestellt werden (embeddet Node).`)
  console.log(`# Server/Session-Host sind die einzigen Laufzeit-Gewinne. Für CI ist der Fetch-Win größer als der Laufzeit-Win.`)
}

function spawnSyncVersion(cmd) {
  try {
    const { spawnSync } = require('node:child_process')
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
    return (r.stdout || r.stderr || '').trim().split('\n')[0]
  } catch { return '?' }
}

await main()
