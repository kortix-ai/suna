/**
 * Bootstrap environment persistence.
 *
 * Core vars (KORTIX_TOKEN, KORTIX_YOLO_API_KEY, KORTIX_API_URL, INTERNAL_SERVICE_KEY,
 * TUNNEL_TOKEN) are the
 * sandbox's identity credentials. They arrive as Docker env vars at container
 * creation and are synced to the s6 env dir on boot.
 *
 * Problem: if process.env loses them (container restart race, env cleared, etc.)
 * AND the s6 env dir is empty, the sandbox can't authenticate to kortix-api.
 * The SecretStore can't help because KORTIX_TOKEN is its own encryption key.
 *
 * Solution: persist these vars in a plaintext JSON file that's always readable.
 * On boot, load from this file BEFORE anything else to ensure they're in
 * process.env. On any update (boot sync, POST /env), re-save the file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

const WORKSPACE_ROOT = process.env.KORTIX_WORKSPACE_ROOT || '/workspace'
const BOOTSTRAP_PATH = process.env.BOOTSTRAP_PATH || `${WORKSPACE_ROOT}/.secrets/.bootstrap-env.json`

const CORE_VARS = ['KORTIX_TOKEN', 'KORTIX_YOLO_API_KEY', 'KORTIX_YOLO_URL', 'KORTIX_API_URL', 'INTERNAL_SERVICE_KEY', 'TUNNEL_TOKEN'] as const

/**
 * Load bootstrap env vars into process.env.
 *
 * IMPORTANT: The bootstrap file is the source of truth for core identity vars.
 * Docker env vars are frozen at container creation time and become stale when
 * the API rotates or re-issues KORTIX_TOKEN. The /env API and injectSandboxToken
 * both update the bootstrap file via updateBootstrapKey(). So on container restart,
 * the bootstrap file has the LATEST token, while Docker env has the ORIGINAL.
 *
 * Therefore: bootstrap file values ALWAYS win over Docker env (process.env).
 * If there's no bootstrap file yet (first boot), Docker env is used as-is.
 *
 * Call this BEFORE SecretStore.loadIntoProcessEnv().
 */
export function loadBootstrapEnv(): number {
  let restored = 0
  try {
    if (!existsSync(BOOTSTRAP_PATH)) return 0
    const data = JSON.parse(readFileSync(BOOTSTRAP_PATH, 'utf-8'))
    for (const key of CORE_VARS) {
      if (data[key]) {
        // Always prefer bootstrap file — it's updated by the /env API and
        // injectSandboxToken, while process.env has the stale Docker creation env.
        if (process.env[key] !== data[key]) {
          process.env[key] = data[key]
          restored++
        }
      }
    }
    if (restored > 0) {
      console.log(`[Bootstrap] Restored ${restored} core env var(s) from ${BOOTSTRAP_PATH}`)
    }
  } catch (err) {
    console.warn('[Bootstrap] Failed to load bootstrap env:', err)
  }
  return restored
}

/**
 * Canonicalize sandbox auth aliases to the sandbox token.
 *
 * Older builds allowed KORTIX_TOKEN, KORTIX_YOLO_API_KEY, INTERNAL_SERVICE_KEY,
 * and TUNNEL_TOKEN to drift apart. The refactored model uses one sandbox token
 * for all four.
 * Normalize process.env before any other startup code reads these values.
 */
export function normalizeBootstrapAuthAliases(): number {
  const canonical = process.env.KORTIX_TOKEN || ''
  if (!canonical) return 0

  let updated = 0
  for (const key of ['KORTIX_YOLO_API_KEY', 'INTERNAL_SERVICE_KEY', 'TUNNEL_TOKEN'] as const) {
    if (process.env[key] !== canonical) {
      process.env[key] = canonical
      updated++
    }
  }

  if (updated > 0) {
    console.log(`[Bootstrap] Normalized ${updated} auth alias(es) to KORTIX_TOKEN`)
  }
  return updated
}

/**
 * Save current core env vars to the bootstrap file.
 * Call this after the core vars are confirmed set in process.env.
 */
export function saveBootstrapEnv(): void {
  try {
    const data: Record<string, string> = {}
    for (const key of CORE_VARS) {
      if (process.env[key]) {
        data[key] = process.env[key]!
      }
    }
    if (Object.keys(data).length === 0) return

    const dir = dirname(BOOTSTRAP_PATH)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    writeFileSync(BOOTSTRAP_PATH, JSON.stringify(data, null, 2), { mode: 0o600 })
  } catch (err) {
    console.warn('[Bootstrap] Failed to save bootstrap env:', err)
  }
}

/**
 * Update a single key in the bootstrap file (for incremental updates via POST /env).
 */
export function updateBootstrapKey(key: string, value: string): void {
  if (!(CORE_VARS as readonly string[]).includes(key)) return
  try {
    let data: Record<string, string> = {}
    if (existsSync(BOOTSTRAP_PATH)) {
      data = JSON.parse(readFileSync(BOOTSTRAP_PATH, 'utf-8'))
    }
    data[key] = value
    const dir = dirname(BOOTSTRAP_PATH)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    writeFileSync(BOOTSTRAP_PATH, JSON.stringify(data, null, 2), { mode: 0o600 })
  } catch (err) {
    console.warn(`[Bootstrap] Failed to update ${key}:`, err)
  }
}
