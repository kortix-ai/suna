/**
 * Forces opencode to bootstrap every project on this sandbox at startup so
 * the kortix-system plugin (which owns the cron trigger scheduler) loads
 * eagerly instead of lazily on first user request.
 *
 * Without this: container respawns, opencode-serve starts, but no project
 * is bootstrapped until someone makes a request. The plugin doesn't load,
 * so cron jobs aren't registered, and any hourly fires that should have
 * happened in the gap are silently dropped. Saw this on 2026-04-27 — a
 * container respawn at 18:10 caused the 18:00 and 19:00 fires to skip;
 * the trigger plugin only registered when an unrelated /session request
 * hit at 19:31.
 *
 * What we do: read projects from .kortix/kortix.db and `GET /session`
 * with `?directory=<project.path>` for each — that's enough to make
 * opencode call `Project.fromDirectory` and load the project-scoped
 * plugin tree (which includes triggers).
 *
 * Idempotent + cheap. Failures are logged and swallowed — opencode's
 * plugin will still load on first real request, this just closes the
 * race.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { config } from '../config'

const POLL_INTERVAL_MS = 1_000
const POLL_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 5_000

async function isOpencodeReachable(): Promise<boolean> {
  try {
    const res = await fetch(
      `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}/session`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    )
    return res.ok
  } catch {
    return false
  }
}

async function waitForOpencode(): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isOpencodeReachable()) return true
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return false
}

function listProjectPaths(): string[] {
  const workspace = process.env.KORTIX_WORKSPACE?.trim() || '/workspace'
  const dbPath = join(workspace, '.kortix', 'kortix.db')
  if (!existsSync(dbPath)) return []

  let db: Database
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    return []
  }

  try {
    const rows = db
      .prepare(`SELECT DISTINCT path FROM projects WHERE path IS NOT NULL AND path <> ''`)
      .all() as Array<{ path: string }>
    return rows.map((r) => r.path).filter((p) => p && p !== '/' && existsSync(p))
  } catch {
    return []
  } finally {
    try { db.close() } catch {}
  }
}

async function bootstrapProject(path: string): Promise<boolean> {
  try {
    const url = `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}/session?directory=${encodeURIComponent(path)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

export async function warmTriggerPluginForAllProjects(): Promise<void> {
  if (!(await waitForOpencode())) {
    console.warn('[trigger-warmer] opencode never came up within 60s; skipping warmup')
    return
  }

  const paths = listProjectPaths()
  if (paths.length === 0) {
    console.log('[trigger-warmer] no projects to warm')
    return
  }

  let warmed = 0
  for (const path of paths) {
    if (await bootstrapProject(path)) warmed++
  }
  console.log(
    `[trigger-warmer] bootstrapped ${warmed}/${paths.length} project(s) — cron triggers should now be registered`,
  )
}
