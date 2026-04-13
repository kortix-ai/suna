import { getEnv } from "../opencode/tools/lib/get-env.js"

/**
 * Parse SANDBOX_PORT_MAP env var into a Record<containerPort, hostPort>.
 * Format: JSON object, e.g. {"8000":"14000","6080":"14002"}
 */
function parsePortMap(): Record<string, string> {
  const raw = process.env.SANDBOX_PORT_MAP
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    console.warn('[Kortix Master] Failed to parse SANDBOX_PORT_MAP:', raw)
    return {}
  }
}

export const config = {
  // Kortix Master port (main entry point)
  PORT: parseInt(process.env.KORTIX_MASTER_PORT || '8000'),

  // OpenCode server (proxied, always unprotected)
  OPENCODE_HOST: process.env.OPENCODE_HOST || 'localhost',
  OPENCODE_PORT: parseInt(process.env.OPENCODE_PORT || '4096'),

  // ─── Kortix Backend ─────────────────────────────────────────────────────────
  // KORTIX_API_URL: base URL of kortix-api. Source of truth is the secrets-manager-
  // backed s6 env file when present; process.env/.env are fallbacks for native dev.
  get KORTIX_API_URL() { return getEnv('KORTIX_API_URL') || 'http://localhost:8008' },

  // KORTIX_TOKEN — direction: sandbox → kortix-api.
  // Source of truth is the secrets-manager-backed s6 env file. This allows token
  // rotation and sync without trusting stale container process.env values.
  get KORTIX_TOKEN() { return getEnv('KORTIX_TOKEN') || '' },

  // Feature flag: enable or disable local deployment routes (/kortix/deploy/*)
  KORTIX_DEPLOYMENTS_ENABLED: process.env.KORTIX_DEPLOYMENTS_ENABLED === 'true',

  // Secret storage
  SECRET_FILE_PATH: process.env.SECRET_FILE_PATH || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/secrets/.secrets.json`,
  SALT_FILE_PATH: process.env.SALT_FILE_PATH || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/secrets/.salt`,
  ENCRYPTION_KEY_PATH: process.env.ENCRYPTION_KEY_PATH || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/secrets/.encryption-key`,

  // Sandbox metadata
  SANDBOX_ID: process.env.SANDBOX_ID || '',
  PROJECT_ID: process.env.PROJECT_ID || '',

  // INTERNAL_SERVICE_KEY — direction: external → sandbox.
  // This is how kortix-api (and other external callers) authenticates TO the sandbox.
  // Every inbound request from outside the container must include this as a Bearer token.
  // Validated by the global auth middleware in index.ts.
  // Localhost requests (from inside the sandbox) bypass auth entirely — no token needed.
  // Counterpart: KORTIX_TOKEN goes the other direction (sandbox → kortix-api).
  // Auto-generates if not provided — external access is ALWAYS auth-protected.
  // In normal operation, kortix-api injects the key as a Docker env var.
  get INTERNAL_SERVICE_KEY(): string {
    const s6EnvDir = process.env.S6_ENV_DIR || '/run/s6/container_environment'
    // Always re-read from s6 env dir first — kortix-api may have written it
    // via docker exec after we started (the fallback sync path). Reading from
    // the file ensures we pick up the injected value without a restart.
    const s6Path = `${s6EnvDir}/INTERNAL_SERVICE_KEY`
    try {
      const { readFileSync } = require('fs')
      const val = readFileSync(s6Path, 'utf8').trim()
      if (val) {
        process.env.INTERNAL_SERVICE_KEY = val
        return val
      }
    } catch {
      // file not present yet — fall through
    }

    const tokenAlias = getEnv('KORTIX_TOKEN') || process.env.KORTIX_TOKEN || ''
    if (tokenAlias) {
      process.env.INTERNAL_SERVICE_KEY = tokenAlias
      return tokenAlias
    }

    if (!process.env.INTERNAL_SERVICE_KEY) {
      console.warn(
        '[Kortix Master] WARNING: No INTERNAL_SERVICE_KEY or KORTIX_TOKEN available.\n' +
        '  Sandbox auth will fail until the canonical sandbox token is synced.'
      )
    }
    return process.env.INTERNAL_SERVICE_KEY || ''
  },

  // Container-port → host-port mappings (set by docker-compose)
  PORT_MAP: parsePortMap(),
}
