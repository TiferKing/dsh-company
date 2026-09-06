'use strict'

// Loaded only by run-dsh-diagnostics.sh, never by the company plugin.
const fs = require('node:fs')
const path = require('node:path')
const v8 = require('node:v8')
const { monitorEventLoopDelay } = require('node:perf_hooks')

function install() {
  if (process.execArgv.some((arg) => ['-e', '--eval', '-p', '--print'].includes(arg))) return
  const inheritedOwner = process.env.DSH_MEMORY_PROBE_PID
  if (inheritedOwner && inheritedOwner !== String(process.pid)) return
  let entry
  try { entry = process.argv[1] && fs.realpathSync(process.argv[1]) } catch { return }
  if (!entry?.endsWith(path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return
  const prefix = '--diagnostic-dir='
  const directory = process.execArgv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  if (!directory) return
  process.env.DSH_MEMORY_PROBE_PID = String(process.pid)

  const file = path.join(directory, `memory-${process.pid}.jsonl`)
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  let timer
  let failed = false
  const mib = (bytes) => Math.round(bytes / 1024 / 1024 * 100) / 100
  const sample = (kind) => {
    if (failed) return
    try {
      const usage = process.memoryUsage()
      const record = {
        at: new Date().toISOString(), kind, pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()), node: process.version,
        ...Object.fromEntries(Object.entries(usage).map(([key, value]) => [`${key}MiB`, mib(value)])),
        heapLimitMiB: mib(v8.getHeapStatistics().heap_size_limit),
        eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6 * 100) / 100,
      }
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      delay.reset()
    } catch (error) {
      failed = true
      clearInterval(timer)
      delay.disable()
      console.error(`[dsh-memory] sampling stopped: ${error.message}`)
    }
  }
  sample('start')
  if (failed) return
  timer = setInterval(() => sample('sample'), 15_000)
  timer.unref()
  process.once('exit', () => { sample('exit'); delay.disable() })
  console.error(`[dsh-memory] pid=${process.pid}; samples=${file}`)
}

install()
