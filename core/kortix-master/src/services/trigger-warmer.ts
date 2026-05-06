/**
 * Forces opencode to bootstrap the single global workspace at startup so
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
 * What we do: `GET /session?directory=/workspace` (or KORTIX_WORKSPACE) —
 * that's enough to make opencode load the single workspace plugin tree
 * (which includes triggers).
 *
 * Idempotent + cheap. Failures are logged and swallowed — opencode's
 * plugin will still load on first real request, this just closes the
 * race.
 */

import { existsSync } from 'fs'
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

function workspacePath(): string {
  return process.env.KORTIX_WORKSPACE?.trim()
    || process.env.WORKSPACE_DIR?.trim()
    || process.env.KORTIX_WORKSPACE_ROOT?.trim()
    || '/workspace'
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

export async function warmTriggerPluginForGlobalWorkspace(): Promise<void> {
  if (!(await waitForOpencode())) {
    console.warn('[trigger-warmer] opencode never came up within 60s; skipping warmup')
    return
  }

  const path = workspacePath()
  if (!existsSync(path)) {
    console.log(`[trigger-warmer] workspace ${path} does not exist; skipping warmup`)
    return
  }

  const warmed = await bootstrapProject(path)
  console.log(`[trigger-warmer] bootstrapped global workspace: ${warmed ? 'ok' : 'failed'} — cron triggers should now be registered`)
}
