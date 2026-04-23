/**
 * TriggerYaml — Read/write .kortix/triggers.yaml ↔ DB reconciler.
 *
 * YAML = declarative config (git-versionable).
 * DB = runtime state.
 * This module handles the sync between them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import yaml from "js-yaml"
import { TriggerStore } from "./trigger-store.js"
import type { YamlTriggerEntry, TriggersYamlFile, TriggerRecord, TriggerSyncResult } from "./types.js"

const EMPTY_YAML: TriggersYamlFile = { triggers: [] }

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export class TriggerYaml {
  private readonly yamlPath: string
  private lastSyncedHash: string = ""
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  /**
   * True once we've completed at least one YAML→DB reconcile in this
   * process. Before the first reconcile, the DB is treated as
   * authoritative (see syncFromYaml): if YAML is empty but DB has rows,
   * we flush DB→YAML instead of deleting DB rows. This prevents a classic
   * race where project_create seeds a trigger directly into the DB
   * moments before the plugin finishes booting, and the plugin's first
   * sync wipes the seed because YAML is still empty.
   */
  private hasBootstrapped: boolean = false

  constructor(
    private readonly store: TriggerStore,
    directory: string,
    private readonly logger?: (level: "info" | "warn" | "error", message: string) => void,
    private readonly onSync?: () => void,
  ) {
    this.yamlPath = path.join(directory, ".kortix", "triggers.yaml")
    mkdirSync(path.dirname(this.yamlPath), { recursive: true })
  }

  // ─── Read YAML ──────────────────────────────────────────────────────────────

  read(): TriggersYamlFile {
    if (!existsSync(this.yamlPath)) return { triggers: [] }
    try {
      const raw = readFileSync(this.yamlPath, "utf8")
      const parsed = yaml.load(raw) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { triggers: [] }
      const file = parsed as Record<string, unknown>
      const triggers = Array.isArray(file.triggers) ? file.triggers : []
      return {
        triggers: triggers
          .map((entry: unknown) => this.normalizeEntry(entry))
          .filter((e): e is YamlTriggerEntry => e !== null),
      }
    } catch (err) {
      this.logger?.("error", `[triggers] Failed to parse triggers.yaml: ${err instanceof Error ? err.message : String(err)}`)
      return { triggers: [] }
    }
  }

  private normalizeEntry(raw: unknown): YamlTriggerEntry | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const entry = raw as Record<string, unknown>

    const name = typeof entry.name === "string" ? entry.name.trim() : ""
    if (!name) return null

    const source = entry.source as Record<string, unknown> | undefined
    if (!source || typeof source !== "object" || !source.type) return null
    const sourceType = String(source.type)
    if (sourceType !== "cron" && sourceType !== "webhook") return null

    const action = (entry.action as Record<string, unknown>) ?? {}
    const actionType = typeof action.type === "string" ? action.type : "prompt"

    return {
      name,
      description: typeof entry.description === "string" ? entry.description : undefined,
      source: {
        type: sourceType as "cron" | "webhook",
        cron_expr: typeof source.cron_expr === "string" ? source.cron_expr : undefined,
        timezone: typeof source.timezone === "string" ? source.timezone : undefined,
        path: typeof source.path === "string" ? source.path : undefined,
        method: typeof source.method === "string" ? source.method : undefined,
        secret: typeof source.secret === "string" ? source.secret : undefined,
      },
      action: {
        type: actionType as any,
        prompt: typeof action.prompt === "string" ? action.prompt : undefined,
        agent: typeof action.agent === "string" ? action.agent : undefined,
        model: typeof action.model === "string" ? action.model : undefined,
        session_mode: typeof action.session_mode === "string" ? action.session_mode : undefined,
        command: typeof action.command === "string" ? action.command : undefined,
        args: Array.isArray(action.args) ? action.args.map(String) : undefined,
        workdir: typeof action.workdir === "string" ? action.workdir : undefined,
        env: action.env && typeof action.env === "object" ? action.env as Record<string, string> : undefined,
        timeout_ms: typeof action.timeout_ms === "number" ? action.timeout_ms : undefined,
        url: typeof action.url === "string" ? action.url : undefined,
        method: typeof (action as any).method === "string" ? (action as any).method : undefined,
        headers: action.headers && typeof action.headers === "object" ? action.headers as Record<string, string> : undefined,
        body_template: typeof action.body_template === "string" ? action.body_template : undefined,
        // ticket_create action fields
        title: typeof action.title === "string" ? action.title : undefined,
        body_md: typeof action.body_md === "string" ? action.body_md : undefined,
        template_id: typeof action.template_id === "string" ? action.template_id : undefined,
        column: typeof action.column === "string" ? action.column : undefined,
        assignee_slugs: Array.isArray(action.assignee_slugs) ? action.assignee_slugs.map(String) : undefined,
      },
      context: entry.context ? {
        extract: (entry.context as any).extract,
        include_raw: (entry.context as any).include_raw,
        session_key: typeof (entry.context as any).session_key === "string" ? (entry.context as any).session_key : undefined,
      } : undefined,
      pipedream: entry.pipedream ? {
        app: String((entry.pipedream as any).app ?? ""),
        component_key: String((entry.pipedream as any).component_key ?? ""),
        configured_props: (entry.pipedream as any).configured_props,
      } : undefined,
    }
  }

  // ─── Write YAML ─────────────────────────────────────────────────────────────

  write(file: TriggersYamlFile): void {
    const content = this.serializeYaml(file)
    writeFileSync(this.yamlPath, content, "utf8")
    this.lastSyncedHash = sha256(content)
  }

  /** Write current DB state to YAML (flush DB → file) */
  flushToYaml(): void {
    const triggers = this.store.list()
    const entries: YamlTriggerEntry[] = triggers.map((t) => this.dbRowToYamlEntry(t))
    this.write({ triggers: entries })
  }

  private dbRowToYamlEntry(t: TriggerRecord): YamlTriggerEntry {
    const sourceConfig = JSON.parse(t.source_config) as Record<string, unknown>
    const actionConfig = JSON.parse(t.action_config) as Record<string, unknown>
    const contextConfig = JSON.parse(t.context_config || "{}") as Record<string, unknown>

    const entry: YamlTriggerEntry = {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      source: {
        type: t.source_type as "cron" | "webhook",
        ...(t.source_type === "cron" ? {
          cron_expr: sourceConfig.cron_expr as string,
          ...(sourceConfig.timezone ? { timezone: sourceConfig.timezone as string } : {}),
        } : {
          path: sourceConfig.path as string,
          ...(sourceConfig.method && sourceConfig.method !== "POST" ? { method: sourceConfig.method as string } : {}),
          ...(sourceConfig.secret ? { secret: sourceConfig.secret as string } : {}),
        }),
      },
      action: {
        type: t.action_type as any,
        ...actionConfig,
        // For prompt actions, also include agent/model from denormalized fields
        ...(t.action_type === "prompt" && t.agent_name ? { agent: t.agent_name } : {}),
        ...(t.action_type === "prompt" && t.model_id ? { model: t.model_id } : {}),
        ...(t.action_type === "prompt" && t.session_mode !== "new" ? { session_mode: t.session_mode } : {}),
      },
    }

    // Context
    if (contextConfig.extract || contextConfig.include_raw !== undefined) {
      entry.context = contextConfig as any
    }

    // Pipedream
    if (t.pipedream_app) {
      entry.pipedream = {
        app: t.pipedream_app,
        component_key: t.pipedream_component ?? "",
        ...(t.pipedream_props && t.pipedream_props !== "{}" ? {
          configured_props: JSON.parse(t.pipedream_props),
        } : {}),
      }
    }

    return entry
  }

  private serializeYaml(file: TriggersYamlFile): string {
    if (file.triggers.length === 0) {
      return "# Trigger definitions — config only, no runtime state.\n# Runtime state (is_active, last_run, executions) lives in kortix.db.\n# This file is the source of truth for what triggers EXIST.\n# Safe to git commit, branch, and share.\n\ntriggers: []\n"
    }
    const header = [
      "# Trigger definitions — config only, no runtime state.",
      "# Runtime state (is_active, last_run, executions) lives in kortix.db.",
      "# This file is the source of truth for what triggers EXIST.",
      "# Safe to git commit, branch, and share.",
      "",
    ].join("\n")

    // Use js-yaml to dump — it handles multi-line strings with block scalars
    const body = yaml.dump(file, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
      quotingType: '"',
      forceQuotes: false,
    })

    return header + body
  }

  // ─── Sync: YAML → DB ───────────────────────────────────────────────────────

  /**
   * Reconcile triggers.yaml into DB.
   * Config fields overwritten. Runtime fields preserved.
   * Returns sync result.
   */
  syncFromYaml(): TriggerSyncResult {
    const result: TriggerSyncResult = { total: 0, created: 0, updated: 0, removed: 0, details: [] }

    // Read and hash
    if (!existsSync(this.yamlPath)) {
      // No YAML file — create empty one, don't delete existing DB triggers
      this.write(EMPTY_YAML)
      return result
    }

    const rawContent = readFileSync(this.yamlPath, "utf8")
    const currentHash = sha256(rawContent)

    // Skip if this is our own write (self-trigger suppression)
    if (currentHash === this.lastSyncedHash && this.lastSyncedHash !== "") {
      return result
    }

    const file = this.read()
    const yamlNames = new Set<string>()

    // Bootstrap safety: on the very first reconcile of this process, if
    // YAML is empty but the DB already has rows (typical when
    // project_create seeded a trigger moments before the plugin finished
    // booting), flush DB→YAML instead of deleting. The alternative —
    // deleting — is the root cause of the "seeded trigger vanishes after
    // boot" bug. Subsequent syncs (post-bootstrap) delete orphans as usual
    // so user-driven YAML edits still work.
    if (!this.hasBootstrapped && file.triggers.length === 0) {
      const dbRows = this.store.list()
      this.hasBootstrapped = true
      if (dbRows.length > 0) {
        this.logger?.("info", `[triggers] First sync: YAML empty but DB has ${dbRows.length} row(s) — flushing DB→YAML to preserve`)
        this.flushToYaml()
        this.lastSyncedHash = sha256(readFileSync(this.yamlPath, "utf8"))
        return result
      }
    }
    this.hasBootstrapped = true

    // Upsert each YAML entry
    for (const entry of file.triggers) {
      yamlNames.add(entry.name)
      const existing = this.store.getByName(entry.name)

      const sourceConfig = this.buildSourceConfig(entry)
      const actionConfig = this.buildActionConfig(entry)
      const contextConfig = entry.context ?? {}

      if (existing) {
        // Update config fields, PRESERVE runtime fields
        this.store.update(existing.id, {
          description: entry.description ?? null,
          source_type: entry.source.type,
          source_config: sourceConfig,
          action_type: entry.action.type ?? "prompt",
          action_config: actionConfig,
          context_config: contextConfig as Record<string, unknown>,
          agent_name: entry.action.agent ?? null,
          model_id: entry.action.model ?? null,
          session_mode: entry.action.session_mode ?? "new",
          pipedream_app: entry.pipedream?.app ?? null,
          pipedream_component: entry.pipedream?.component_key ?? null,
          pipedream_props: entry.pipedream?.configured_props ?? {},
          // Runtime fields NOT touched: is_active, last_run_at, session_id, event_count, etc.
        })
        result.updated++
        result.details.push(`updated: ${entry.name}`)
      } else {
        // Create new
        this.store.create({
          name: entry.name,
          description: entry.description ?? null,
          source_type: entry.source.type,
          source_config: sourceConfig,
          action_type: entry.action.type ?? "prompt",
          action_config: actionConfig,
          context_config: contextConfig as Record<string, unknown>,
          agent_name: entry.action.agent ?? null,
          model_id: entry.action.model ?? null,
          session_mode: entry.action.session_mode ?? "new",
          pipedream_app: entry.pipedream?.app ?? null,
          pipedream_component: entry.pipedream?.component_key ?? null,
          pipedream_props: entry.pipedream?.configured_props ?? {},
        })
        result.created++
        result.details.push(`created: ${entry.name}`)
      }
    }

    // Remove DB triggers not in YAML
    const allDb = this.store.list()
    for (const dbTrigger of allDb) {
      if (!yamlNames.has(dbTrigger.name)) {
        this.store.delete(dbTrigger.id)
        result.removed++
        result.details.push(`removed: ${dbTrigger.name}`)
      }
    }

    result.total = yamlNames.size
    this.lastSyncedHash = currentHash
    this.logger?.("info", `[triggers] YAML sync: ${result.created} created, ${result.updated} updated, ${result.removed} removed`)

    return result
  }

  private buildSourceConfig(entry: YamlTriggerEntry): Record<string, unknown> {
    if (entry.source.type === "cron") {
      return {
        cron_expr: entry.source.cron_expr ?? "",
        timezone: entry.source.timezone ?? "UTC",
      }
    }
    return {
      path: entry.source.path ?? "",
      method: entry.source.method ?? "POST",
      secret: entry.source.secret,
    }
  }

  private buildActionConfig(entry: YamlTriggerEntry): Record<string, unknown> {
    const type = entry.action.type ?? "prompt"
    if (type === "prompt") {
      return {
        prompt: entry.action.prompt ?? "",
      }
    }
    if (type === "command") {
      return {
        command: entry.action.command ?? "",
        args: entry.action.args,
        workdir: entry.action.workdir,
        env: entry.action.env,
        timeout_ms: entry.action.timeout_ms,
      }
    }
    if (type === "http") {
      return {
        url: entry.action.url ?? "",
        method: entry.action.method ?? "POST",
        headers: entry.action.headers,
        body_template: entry.action.body_template,
        timeout_ms: entry.action.timeout_ms,
      }
    }
    if (type === "ticket_create") {
      return {
        title: entry.action.title ?? "",
        body_md: entry.action.body_md,
        template_id: entry.action.template_id,
        column: entry.action.column,
        assignee_slugs: entry.action.assignee_slugs,
      }
    }
    return {}
  }

  // ─── Write-through: DB → YAML (on API mutations) ──────────────────────────

  /** After an API create/update/delete, flush the current DB state to YAML */
  writeThrough(): void {
    this.flushToYaml()
  }

  // ─── File Watcher ─────────────────────────────────────────────────────────

  startWatching(): void {
    this.stopWatching()

    // Watch the .kortix directory for triggers.yaml changes
    const watchDir = path.dirname(this.yamlPath)
    try {
      this.watcher = watch(watchDir, { persistent: false }, (_event, filename) => {
        if (filename !== "triggers.yaml") return
        this.debouncedSync()
      })
      this.logger?.("info", `[triggers] Watching ${watchDir} for triggers.yaml changes`)
    } catch {
      // Directory may not exist — fine
    }

    // Periodic reconcile fallback (every 30s) for unreliable file watchers (Docker volumes)
    this.periodicTimer = setInterval(() => {
      try {
        if (!existsSync(this.yamlPath)) return
        const rawContent = readFileSync(this.yamlPath, "utf8")
        const currentHash = sha256(rawContent)
        if (currentHash !== this.lastSyncedHash) {
          this.logger?.("info", "[triggers] Periodic reconcile detected triggers.yaml change")
          this.syncFromYaml()
          this.onSync?.()
        }
      } catch {}
    }, 30_000)
  }

  stopWatching(): void {
    if (this.watcher) {
      try { this.watcher.close() } catch {}
      this.watcher = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }
  }

  private debouncedSync(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      try {
        this.syncFromYaml()
        this.onSync?.()
      } catch (err) {
        this.logger?.("error", `[triggers] File watcher sync failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, 500)
  }

  getYamlPath(): string {
    return this.yamlPath
  }
}
