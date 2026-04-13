#!/usr/bin/env bun
/**
 * cli-lib.ts — Shared utilities for all Kortix CLI tools.
 *
 * Provides:
 *   - Consistent JSON output
 *   - Environment resolution (s6 → process.env → .env file)
 *   - HTTP helpers with auth
 *   - Argument parsing
 *   - Error handling
 *
 * Usage:
 *   import { out, getEnv, authHeaders, masterUrl, parseArgs, CliError } from "./cli-lib"
 */

import { readFileSync, existsSync } from "node:fs"
import * as path from "node:path"

// ─── JSON output ─────────────────────────────────────────────────────────────

export function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export class CliError extends Error {
  constructor(
    message: string,
    public code: string = "CLI_ERROR",
    public exitCode: number = 1
  ) {
    super(message)
    this.name = "CliError"
  }
}

export function handleError(err: unknown): never {
  if (err instanceof CliError) {
    out({ ok: false, error: err.message, code: err.code })
    process.exit(err.exitCode)
  }
  out({ ok: false, error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
}

// ─── Environment resolution ─────────────────────────────────────────────────

export const S6_ENV_DIR = process.env.S6_ENV_DIR || "/run/s6/container_environment"

export function getEnv(key: string): string | undefined {
  // 1. Try s6 env dir (runtime secrets)
  try {
    const val = readFileSync(`${S6_ENV_DIR}/${key}`, "utf-8").trim()
    if (val) return val
  } catch {}

  // 2. Try process.env
  if (process.env[key]) return process.env[key]

  // 3. Try .env file in workspace
  const workspace = process.env.KORTIX_WORKSPACE || process.cwd()
  try {
    const envPath = path.join(workspace, ".env")
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8")
      const match = content.match(new RegExp(`^${key}=(.+)$`, "m"))
      if (match) return match[1].trim().replace(/^["']|["']$/g, "")
    }
  } catch {}

  return undefined
}

export function requireEnv(key: string): string {
  const val = getEnv(key)
  if (!val) throw new CliError(`${key} not set`, "MISSING_ENV", 1)
  return val
}

// ─── Master API helpers ──────────────────────────────────────────────────────

export function masterUrl(): string {
  return (getEnv("KORTIX_MASTER_URL") || "http://localhost:8000").trim()
}

export function authHeaders(): Record<string, string> {
  const key = getEnv("INTERNAL_SERVICE_KEY")
  return {
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  }
}

export async function apiGet(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(path, masterUrl())
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  }
  const res = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new CliError(`${res.status}: ${text}`, "API_ERROR", 1)
  }
  return res.json()
}

export async function apiPost(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${masterUrl()}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new CliError(`${res.status}: ${text}`, "API_ERROR", 1)
  }
  return res.json()
}

// ─── Argument parsing ────────────────────────────────────────────────────────

export interface ParsedArgs {
  command: string
  args: string[]
  flags: Record<string, string>
  apps: string[] // for repeated --app flags
}

export function parseArgs(argv: string[], options?: { collectApps?: boolean }): ParsedArgs {
  const all = argv.slice(2)
  const command = all[0] ?? "help"
  const args: string[] = []
  const flags: Record<string, string> = {}
  const apps: string[] = []

  for (let i = 1; i < all.length; i++) {
    const a = all[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const val = all[i + 1] && !all[i + 1]!.startsWith("--") ? all[++i]! : "true"
      if (options?.collectApps && key === "app") {
        apps.push(val)
      } else {
        flags[key] = val
      }
    } else {
      args.push(a)
    }
  }

  // Also put first app into flags for convenience
  if (apps.length && !flags.app) flags.app = apps[0]!

  return { command, args, flags, apps }
}

// ─── Database path resolution ────────────────────────────────────────────────

export function resolveDbPath(): string {
  const root = process.env.KORTIX_WORKSPACE?.trim()
    || (process.env.OPENCODE_CONFIG_DIR?.trim()
      ? path.dirname(path.resolve(process.env.OPENCODE_CONFIG_DIR))
      : (process.env.HOME ? path.join(process.env.HOME, "") : process.cwd()))

  for (const candidate of [
    path.join(root, ".kortix", "kortix.db"),
    "/workspace/.kortix/kortix.db",
  ]) {
    const dir = path.dirname(candidate)
    if (existsSync(dir)) return candidate
  }

  const dbDir = path.join(root, ".kortix")
  try {
    const { mkdirSync } = await import("node:fs")
    mkdirSync(dbDir, { recursive: true })
  } catch {}

  return path.join(dbDir, "kortix.db")
}

// ─── Validation helpers ──────────────────────────────────────────────────────

export function validateRequired(flags: Record<string, string>, ...keys: string[]): void {
  const missing = keys.filter(k => !flags[k])
  if (missing.length) {
    throw new CliError(`Missing required: ${missing.map(k => `--${k}`).join(", ")}`, "MISSING_ARGS", 1)
  }
}

export function validateUrl(url: string): void {
  try {
    new URL(url)
  } catch {
    throw new CliError(`Invalid URL: ${url}`, "INVALID_URL", 1)
  }
}

// ─── Format helpers ──────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  return iso.slice(0, 10) // YYYY-MM-DD
}

export function formatDateTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 19) // YYYY-MM-DD HH:MM:SS
}
