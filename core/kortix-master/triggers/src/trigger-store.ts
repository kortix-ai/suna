/**
 * TriggerStore — Unified SQLite CRUD against kortix.db:triggers + trigger_executions.
 *
 * Single source of truth for all trigger runtime state.
 * Config fields are synced from triggers.yaml; runtime fields live here only.
 */
import { mkdirSync, existsSync, statSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Cron } from "croner"
import type { TriggerRecord, ExecutionRecord, ExecutionStatus } from "./types.js"

// bun:sqlite typings
type BunDatabase = any

export function isValidCronExpression(expr: string): boolean {
  try { new Cron(expr); return true } catch { return false }
}

export function getNextRun(expr: string, timezone = "UTC"): Date | null {
  try { return new Cron(expr, { timezone }).nextRun() ?? null } catch { return null }
}

export function describeCron(expr: string): string {
  try {
    const parts = expr.trim().split(/\s+/)
    if (parts.length !== 6) return expr
    const [sec, min, hour, day, month, weekday] = parts as [string, string, string, string, string, string]
    if (sec.startsWith("*/") && min === "*" && hour === "*") return `Every ${sec.slice(2)} seconds`
    if (sec === "0" && min.startsWith("*/") && hour === "*") return `Every ${min.slice(2)} minutes`
    if (sec === "0" && min === "0" && hour.startsWith("*/")) return `Every ${hour.slice(2)} hours`
    if (sec === "0" && !min.includes("*") && !hour.includes("*") && day === "*" && month === "*" && weekday === "*") {
      return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`
    }
    return expr
  } catch { return expr }
}

export class TriggerStore {
  private db: BunDatabase

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true })

    // Clean orphaned/corrupt DB files
    try {
      const dbExists = existsSync(dbPath)
      const dbEmpty = dbExists && statSync(dbPath).size === 0
      if (!dbExists || dbEmpty) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          try { unlinkSync(dbPath + suffix) } catch {}
        }
      }
    } catch {}

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite")
    let db: BunDatabase
    try {
      db = new Database(dbPath)
    } catch {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try { unlinkSync(dbPath + suffix) } catch {}
      }
      db = new Database(dbPath)
    }
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON")
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        description     TEXT,
        source_type     TEXT NOT NULL,
        source_config   TEXT NOT NULL DEFAULT '{}',
        action_type     TEXT NOT NULL DEFAULT 'prompt',
        action_config   TEXT NOT NULL DEFAULT '{}',
        context_config  TEXT DEFAULT '{}',
        agent_name      TEXT,
        model_id        TEXT,
        session_mode    TEXT DEFAULT 'new',
        session_id      TEXT,
        pipedream_app           TEXT,
        pipedream_component     TEXT,
        pipedream_deployed_id   TEXT,
        pipedream_webhook_url   TEXT,
        pipedream_props         TEXT DEFAULT '{}',
        is_active       INTEGER DEFAULT 1,
        last_run_at     TEXT,
        next_run_at     TEXT,
        last_event_at   TEXT,
        event_count     INTEGER DEFAULT 0,
        metadata        TEXT DEFAULT '{}',
        carry_state     INTEGER DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_triggers_source ON triggers(source_type);
      CREATE INDEX IF NOT EXISTS idx_triggers_active ON triggers(is_active);

      CREATE TABLE IF NOT EXISTS trigger_executions (
        id              TEXT PRIMARY KEY,
        trigger_id      TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
        status          TEXT NOT NULL DEFAULT 'running',
        session_id      TEXT,
        error_message   TEXT,
        stdout          TEXT,
        stderr          TEXT,
        exit_code       INTEGER,
        http_status     INTEGER,
        http_body       TEXT,
        retry_count     INTEGER DEFAULT 0,
        metadata        TEXT DEFAULT '{}',
        started_at      TEXT NOT NULL,
        completed_at    TEXT,
        duration_ms     INTEGER,
        result_text     TEXT,
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_texec_trigger ON trigger_executions(trigger_id);
      CREATE INDEX IF NOT EXISTS idx_texec_created ON trigger_executions(created_at DESC);
    `)

    // ── Additive column migrations (ALTER TABLE for existing DBs) ─────────────
    const addIfMissing = (table: string, column: string, definition: string) => {
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`) } catch { /* already exists */ }
    }
    addIfMissing("trigger_executions", "result_text", "TEXT")
    addIfMissing("triggers", "carry_state", "INTEGER DEFAULT 0")
  }

  // ─── Trigger CRUD ───────────────────────────────────────────────────────────

  list(filter?: { source_type?: string; is_active?: boolean }): TriggerRecord[] {
    let sql = "SELECT * FROM triggers"
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter?.source_type) {
      conditions.push("source_type = ?")
      params.push(filter.source_type)
    }
    if (filter?.is_active !== undefined) {
      conditions.push("is_active = ?")
      params.push(filter.is_active ? 1 : 0)
    }

    if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ")
    sql += " ORDER BY created_at DESC"

    return (this.db.query(sql).all(...params) as TriggerRecord[])
  }

  get(id: string): TriggerRecord | null {
    return (this.db.query("SELECT * FROM triggers WHERE id = ?").get(id) as TriggerRecord | null)
  }

  getByName(name: string): TriggerRecord | null {
    return (this.db.query("SELECT * FROM triggers WHERE name = ?").get(name) as TriggerRecord | null)
  }

  create(input: {
    name: string
    description?: string | null
    source_type: string
    source_config: Record<string, unknown>
    action_type?: string
    action_config: Record<string, unknown>
    context_config?: Record<string, unknown>
    agent_name?: string | null
    model_id?: string | null
    session_mode?: string
    pipedream_app?: string | null
    pipedream_component?: string | null
    pipedream_props?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }): TriggerRecord {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    // Compute next_run_at for cron triggers
    let next_run_at: string | null = null
    if (input.source_type === "cron") {
      const sc = input.source_config as { cron_expr?: string; timezone?: string }
      if (sc.cron_expr) {
        next_run_at = getNextRun(sc.cron_expr, sc.timezone ?? "UTC")?.toISOString() ?? null
      }
    }

    this.db.query(`
      INSERT INTO triggers (
        id, name, description, source_type, source_config, action_type, action_config,
        context_config, agent_name, model_id, session_mode, session_id,
        pipedream_app, pipedream_component, pipedream_deployed_id, pipedream_webhook_url, pipedream_props,
        is_active, last_run_at, next_run_at, last_event_at, event_count,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 1, NULL, ?, NULL, 0, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.description ?? null,
      input.source_type,
      JSON.stringify(input.source_config),
      input.action_type ?? "prompt",
      JSON.stringify(input.action_config),
      JSON.stringify(input.context_config ?? {}),
      input.agent_name ?? null,
      input.model_id ?? null,
      input.session_mode ?? "new",
      input.pipedream_app ?? null,
      input.pipedream_component ?? null,
      JSON.stringify(input.pipedream_props ?? {}),
      next_run_at,
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    )

    return this.get(id)!
  }

  update(id: string, patch: Partial<{
    name: string
    description: string | null
    source_type: string
    source_config: Record<string, unknown>
    action_type: string
    action_config: Record<string, unknown>
    context_config: Record<string, unknown>
    agent_name: string | null
    model_id: string | null
    session_mode: string
    session_id: string | null
    pipedream_app: string | null
    pipedream_component: string | null
    pipedream_deployed_id: string | null
    pipedream_webhook_url: string | null
    pipedream_props: Record<string, unknown>
    is_active: boolean
    last_run_at: string | null
    next_run_at: string | null
    last_event_at: string | null
    event_count: number
    metadata: Record<string, unknown>
  }>): TriggerRecord | null {
    const current = this.get(id)
    if (!current) return null

    const sets: string[] = []
    const params: unknown[] = []

    const addField = (field: string, value: unknown) => {
      if (value !== undefined) {
        sets.push(`${field} = ?`)
        params.push(value)
      }
    }

    addField("name", patch.name)
    addField("description", patch.description)
    addField("source_type", patch.source_type)
    if (patch.source_config !== undefined) addField("source_config", JSON.stringify(patch.source_config))
    addField("action_type", patch.action_type)
    if (patch.action_config !== undefined) addField("action_config", JSON.stringify(patch.action_config))
    if (patch.context_config !== undefined) addField("context_config", JSON.stringify(patch.context_config))
    addField("agent_name", patch.agent_name)
    addField("model_id", patch.model_id)
    addField("session_mode", patch.session_mode)
    addField("session_id", patch.session_id)
    addField("pipedream_app", patch.pipedream_app)
    addField("pipedream_component", patch.pipedream_component)
    addField("pipedream_deployed_id", patch.pipedream_deployed_id)
    addField("pipedream_webhook_url", patch.pipedream_webhook_url)
    if (patch.pipedream_props !== undefined) addField("pipedream_props", JSON.stringify(patch.pipedream_props))
    if (patch.is_active !== undefined) addField("is_active", patch.is_active ? 1 : 0)
    addField("last_run_at", patch.last_run_at)
    addField("next_run_at", patch.next_run_at)
    addField("last_event_at", patch.last_event_at)
    if (patch.event_count !== undefined) addField("event_count", patch.event_count)
    if (patch.metadata !== undefined) addField("metadata", JSON.stringify(patch.metadata))

    if (sets.length === 0) return current

    // Always update updated_at
    sets.push("updated_at = ?")
    params.push(new Date().toISOString())

    params.push(id)
    this.db.query(`UPDATE triggers SET ${sets.join(", ")} WHERE id = ?`).run(...params)

    // Recompute next_run_at if cron config changed
    const updated = this.get(id)!
    if (updated.source_type === "cron" && (patch.source_config || patch.is_active !== undefined)) {
      const sc = JSON.parse(updated.source_config) as { cron_expr?: string; timezone?: string }
      const nextRun = updated.is_active && sc.cron_expr
        ? getNextRun(sc.cron_expr, sc.timezone ?? "UTC")?.toISOString() ?? null
        : null
      this.db.query("UPDATE triggers SET next_run_at = ? WHERE id = ?").run(nextRun, id)
    }

    return this.get(id)
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM triggers WHERE id = ?").run(id) as { changes: number }
    return result.changes > 0
  }

  deleteByName(name: string): boolean {
    const result = this.db.query("DELETE FROM triggers WHERE name = ?").run(name) as { changes: number }
    return result.changes > 0
  }

  // ─── Runtime state helpers ────────────────────────────────────────────────

  markRun(id: string, sessionId?: string | null): TriggerRecord | null {
    const trigger = this.get(id)
    if (!trigger) return null
    const sc = JSON.parse(trigger.source_config) as { cron_expr?: string; timezone?: string }
    const nextRun = trigger.source_type === "cron" && sc.cron_expr
      ? getNextRun(sc.cron_expr, sc.timezone ?? "UTC")?.toISOString() ?? null
      : null
    return this.update(id, {
      last_run_at: new Date().toISOString(),
      next_run_at: nextRun,
      session_id: sessionId ?? undefined,
    })
  }

  recordEvent(id: string): TriggerRecord | null {
    const trigger = this.get(id)
    if (!trigger) return null
    return this.update(id, {
      last_event_at: new Date().toISOString(),
      event_count: trigger.event_count + 1,
    })
  }

  // ─── Execution CRUD ─────────────────────────────────────────────────────────

  createExecution(triggerId: string, input?: {
    status?: ExecutionStatus
    retry_count?: number
    metadata?: Record<string, unknown>
  }): ExecutionRecord {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db.query(`
      INSERT INTO trigger_executions (id, trigger_id, status, retry_count, metadata, started_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, triggerId,
      input?.status ?? "running",
      input?.retry_count ?? 0,
      JSON.stringify(input?.metadata ?? {}),
      now, now,
    )
    return this.getExecution(id)!
  }

  updateExecution(executionId: string, patch: Partial<ExecutionRecord>): ExecutionRecord | null {
    const current = this.getExecution(executionId)
    if (!current) return null

    const sets: string[] = []
    const params: unknown[] = []
    const addField = (field: string, value: unknown) => {
      if (value !== undefined) {
        sets.push(`${field} = ?`)
        params.push(value)
      }
    }

    addField("status", patch.status)
    addField("session_id", patch.session_id)
    addField("error_message", patch.error_message)
    addField("stdout", patch.stdout)
    addField("stderr", patch.stderr)
    addField("exit_code", patch.exit_code)
    addField("http_status", patch.http_status)
    addField("http_body", patch.http_body)
    addField("retry_count", patch.retry_count)
    if (patch.metadata) addField("metadata", JSON.stringify(patch.metadata))
    addField("completed_at", patch.completed_at)
    addField("duration_ms", patch.duration_ms)
    addField("result_text", patch.result_text)

    if (sets.length === 0) return current
    params.push(executionId)
    this.db.query(`UPDATE trigger_executions SET ${sets.join(", ")} WHERE id = ?`).run(...params)
    return this.getExecution(executionId)
  }

  getExecution(executionId: string): ExecutionRecord | null {
    return (this.db.query("SELECT * FROM trigger_executions WHERE id = ?").get(executionId) as ExecutionRecord | null)
  }

  listExecutions(filter?: { triggerId?: string; limit?: number; offset?: number }): { data: ExecutionRecord[]; total: number } {
    const where = filter?.triggerId ? "WHERE trigger_id = ?" : ""
    const params = filter?.triggerId ? [filter.triggerId] : []
    const countRow = this.db.query(`SELECT COUNT(*) as cnt FROM trigger_executions ${where}`).get(...params) as { cnt: number }
    const total = countRow.cnt
    const limit = filter?.limit ?? 50
    const offset = filter?.offset ?? 0
    const rows = this.db.query(`SELECT * FROM trigger_executions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ExecutionRecord[]
    return { data: rows, total }
  }
}
