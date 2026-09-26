#!/usr/bin/env node
/**
 * `npm run dist` / `npm run pack` wrapper.
 *
 * An on-access virus scan on this machine sees the ~240 MB Electron executable land in
 * `dist/win-unpacked` and holds it open while electron-builder is still stamping resources into that
 * same file. The scan wins the race often enough that a build dies with EBUSY partway through — after
 * minutes of work. Two layers handle it: `patches/app-builder-lib+*.patch` retries the individual
 * read/write (the common case, the handle is released within a couple of seconds), and this script
 * retries the whole build when something slipped through anyway.
 *
 * A non-lock failure (bad config, missing icon) fails within seconds, before extraction, so
 * burning an extra attempt on it costs nothing worth branching for.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked')
const CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
const ATTEMPTS = 3

/** A half-written `win-unpacked` is regenerated from scratch anyway, so clearing it is safe —
 *  and if it is still locked, say so and let the next attempt fight for it rather than dying here. */
async function clearUnpacked() {
  if (!existsSync(UNPACKED)) return
  try {
    // `rm` retries EBUSY/EPERM internally, which is exactly what is still holding the directory.
    await rm(UNPACKED, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 })
  } catch (e) {
    console.log(`[dist] ${path.relative(ROOT, UNPACKED)} 还锁着（${e.code ?? e.message}），不清了，交给下一趟自己腾空`)
  }
}

async function attempt() {
  return await new Promise((resolve, reject) => {
    // Inherited stdio on purpose: capture-and-replay makes electron-builder think it is not on a
    // terminal, which changes its progress output. Nothing here needs to read that output.
    const child = spawn(process.execPath, [CLI, ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
}

for (let i = 1; i <= ATTEMPTS; i++) {
  const code = await attempt()
  if (code === 0) process.exit(0)
  if (i === ATTEMPTS) {
    console.error(`[dist] gave up after ${ATTEMPTS} attempts (exit ${code})`)
    process.exit(code)
  }
  console.log(`[dist] attempt ${i} exited ${code} — retrying the whole build (antivirus handle contention?)`)
  await clearUnpacked()
}
