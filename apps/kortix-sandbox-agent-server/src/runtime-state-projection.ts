/**
 * The runtime state projection behind `GET /kortix/opencode/state`.
 *
 * ONE READ REPLACES SEVEN. A session open issues `/agent`, `/command`,
 * `/config`, `/session`, `/session/status`, `/permission` and `/question` —
 * 3.3 MB across seven round trips, each paying the ~1.4 s proxied floor, for
 * about 8 KB of facts (WS-V §1.1, §3.5). This module builds those facts once,
 * inside the VM where each read costs 3-112 ms, keeps them current from the
 * SSE stream the daemon already subscribes to, and serves them gzipped with an
 * etag.
 *
 * FRESHNESS MODEL — two classes of fact, two mechanisms:
 *
 *  - **Catalog** (`agents`, `commands`, `config`): changes only when the agent
 *    config is recompiled, an MCP server's tools change, or OpenCode is
 *    replaced. Built once and INVALIDATED by those events. `POST /kortix/env`
 *    and a verified reload call {@link invalidateRuntimeState} directly — the
 *    daemon owns that write, so it does not have to discover it.
 *  - **Live** (`sessions`, `statuses`, `permissions`, `questions`): maintained
 *    INCREMENTALLY from the SSE frames — `permission.asked/replied`,
 *    `question.asked/replied/rejected`, `session.status`, `session.*`. This is
 *    the deletion of the 2 s `/permission` and `/question` self-heal polls: the
 *    state route answers what those polls were asking, from frames that already
 *    arrive, at zero extra cost.
 *
 * A `stale` floor (15 min) backstops both: if every trigger were somehow
 * missed, state is at most one floor old, and `built_at`/`age_ms` on the wire
 * make that visible rather than silent.
 *
 * TRI-STATE, ALWAYS (`known: true|false`). A section the daemon could not read
 * is `known: false` with a reason — never an empty list. An empty agent roster
 * rendered as fact is the failure mode this whole design exists to avoid, and
 * `open-bundle` already carries the same discipline
 * (`session-open-bundle.ts:32-35`).
 */
import { logger } from './logger'
import type { Config } from './config'
import type { Opencode } from './opencode'
import { OpencodeDb, isSupportedOpencodeVersion } from './opencode-db'
import { kortixEventBus } from './kortix-event-bus'
import {
  type AgentProjection,
  type CommandProjection,
  type ConfigProjection,
  type PermissionProjection,
  type QuestionProjection,
  type SessionProjection,
  etagOf,
  projectAgents,
  projectCommands,
  projectConfig,
  projectPermissions,
  projectQuestions,
  projectSessionRows,
  projectSessions,
  projectStatuses,
} from './opencode-projection'

/** Upper bound on how old a served projection can be before a forced rebuild. */
export const RUNTIME_STATE_FLOOR_MS = 15 * 60_000
/** Per-read budget against OpenCode. Its slowest projected read is `/config` (112 ms). */
export const RUNTIME_STATE_READ_TIMEOUT_MS = 5_000

export type RuntimeStateSection = 'catalog' | 'sessions' | 'live'

export interface Known<T> {
  known: boolean
  reason?: string
  value: T
}

export interface RuntimeStateDoc {
  /** The daemon boot this projection belongs to; `seq` is only valid inside it. */
  epoch: string
  /** Bus watermark at build time — the client's starting cursor for `/events`. */
  seq: number
  built_at: string
  identity: {
    /** The OpenCode conversation this box is pinned to. */
    opencode_session_id: string | null
    opencode_version: string | null
    /** Manifest epoch of the daemon binary, from the convergence report. */
    daemon_build: number | null
    /** Content hash of the compiled agent config this OpenCode spawned with. */
    agent_config_etag: string | null
    /**
     * OpenCode's OWN durable cursor per aggregate (`event_sequence.seq`).
     * Not the stream's `seq` — see `kortix-event-bus.ts`. It is what
     * `/messages?after_seq=` takes, so a client can fetch a transcript delta
     * without replaying deltas.
     */
    head_seq: Record<string, number> | null
  }
  agents: Known<AgentProjection[]>
  commands: Known<CommandProjection[]>
  config: Known<ConfigProjection>
  sessions: Known<SessionProjection[]>
  statuses: Known<Record<string, { type: string }>>
  permissions: Known<PermissionProjection[]>
  questions: Known<QuestionProjection[]>
}

export interface RuntimeStateResult {
  doc: RuntimeStateDoc
  etag: string
  /** Milliseconds spent reading OpenCode/SQLite for this call. 0 on a cache hit. */
  readMs: number
}

export interface RuntimeStateDeps {
  opencode: Opencode
  cfg: Config
  db: OpencodeDb
  /** The pinned OpenCode session id. */
  pinnedSessionId: () => string | null
  /** Manifest epoch of the running daemon (the convergence report's `build`). */
  daemonBuild: () => number | null | Promise<number | null>
  now?: () => number
}

async function readJson(url: string, timeoutMs = RUNTIME_STATE_READ_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${res.status}`)
  return (await res.json()) as unknown
}

function known<T>(value: T): Known<T> {
  return { known: true, value }
}

function unknownSection<T>(reason: string, empty: T): Known<T> {
  return { known: false, reason, value: empty }
}

/**
 * Build, cache and incrementally maintain the projection.
 *
 * One instance per daemon (see {@link configureRuntimeState}). Concurrent
 * `read()` calls share one in-flight build — a session open fires several
 * requests at once and must not produce several `/config` reads.
 */
export class RuntimeStateStore {
  private doc: RuntimeStateDoc | null = null
  private etag: string | null = null
  private builtAtMs = 0
  private dirty = new Set<RuntimeStateSection>(['catalog', 'sessions', 'live'])
  private inFlight: Promise<void> | null = null
  private versionProbe: Promise<string | null> | null = null
  private readonly now: () => number

  constructor(private readonly deps: RuntimeStateDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Mark a section for rebuild. Cheap and synchronous — safe from any caller. */
  invalidate(section: RuntimeStateSection | 'all', reason: string): void {
    if (section === 'all') {
      this.dirty.add('catalog')
      this.dirty.add('sessions')
      this.dirty.add('live')
    } else {
      this.dirty.add(section)
    }
    logger.info('[runtime-state] invalidated', { section, reason })
  }

  /**
   * Apply one OpenCode SSE frame.
   *
   * Returns true when the frame changed the projection — used only for logging
   * and tests; the route always reads through {@link read}.
   */
  noteEvent(event: { type?: string; properties?: unknown }): boolean {
    const type = event?.type
    if (typeof type !== 'string') return false
    const props = (event.properties ?? {}) as Record<string, unknown>
    const doc = this.doc

    // Catalog invalidation. These are the four ways the roster can move.
    if (
      type === 'server.instance.disposed' ||
      type === 'mcp.tools.changed' ||
      type === 'global.disposed' ||
      type === 'plugin.added'
    ) {
      this.invalidate('catalog', type)
      return true
    }

    if (!doc) return false

    switch (type) {
      case 'permission.asked': {
        const projected = projectPermissions([props])[0]
        if (!projected) return false
        doc.permissions = known([
          ...doc.permissions.value.filter((p) => p.id !== projected.id),
          projected,
        ])
        this.etag = null
        return true
      }
      case 'permission.replied': {
        const id = typeof props.requestID === 'string' ? props.requestID : null
        if (!id) return false
        doc.permissions = known(doc.permissions.value.filter((p) => p.id !== id))
        this.etag = null
        return true
      }
      case 'question.asked': {
        const projected = projectQuestions([props])[0]
        if (!projected) return false
        doc.questions = known([
          ...doc.questions.value.filter((q) => q.id !== projected.id),
          projected,
        ])
        this.etag = null
        return true
      }
      case 'question.replied':
      case 'question.rejected': {
        const id = typeof props.requestID === 'string' ? props.requestID : null
        if (!id) return false
        doc.questions = known(doc.questions.value.filter((q) => q.id !== id))
        this.etag = null
        return true
      }
      case 'session.status': {
        const sessionID = typeof props.sessionID === 'string' ? props.sessionID : null
        const status = props.status as { type?: unknown } | undefined
        if (!sessionID || typeof status?.type !== 'string') return false
        doc.statuses = known({ ...doc.statuses.value, [sessionID]: { type: status.type } })
        this.etag = null
        return true
      }
      case 'session.idle': {
        const sessionID = typeof props.sessionID === 'string' ? props.sessionID : null
        if (!sessionID) return false
        doc.statuses = known({ ...doc.statuses.value, [sessionID]: { type: 'idle' } })
        this.etag = null
        return true
      }
      case 'session.created':
      case 'session.updated':
      case 'session.compacted': {
        // The frame carries the whole row, so the list updates in place: no
        // read, no round trip. `session.created` for a Task child lands here
        // too, which is correct — the picker lists children.
        const projected = projectSessions([props.info ?? props])[0]
        if (!projected) {
          this.invalidate('sessions', type)
          return true
        }
        doc.sessions = known(
          [
            ...doc.sessions.value.filter((s) => s.id !== projected.id),
            projected,
          ].sort((a, b) => b.time.updated - a.time.updated),
        )
        this.etag = null
        return true
      }
      case 'session.deleted': {
        const info = (props.info ?? props) as { id?: unknown }
        const id = typeof info.id === 'string' ? info.id : null
        if (!id) return false
        doc.sessions = known(doc.sessions.value.filter((s) => s.id !== id))
        doc.statuses = known(
          Object.fromEntries(Object.entries(doc.statuses.value).filter(([key]) => key !== id)),
        )
        this.etag = null
        return true
      }
      default:
        return false
    }
  }

  /** Serve the projection, rebuilding only what is dirty or past the floor. */
  async read(): Promise<RuntimeStateResult> {
    const t0 = performance.now()
    if (this.doc && this.now() - this.builtAtMs > RUNTIME_STATE_FLOOR_MS) {
      this.invalidate('all', 'floor')
    }
    if (!this.doc || this.dirty.size > 0) {
      if (!this.inFlight) {
        this.inFlight = this.rebuild().finally(() => {
          this.inFlight = null
        })
      }
      await this.inFlight
    }
    const doc = this.doc!
    // The stream cursor must be the bus head AT SERVE TIME, not at build time:
    // a client that opens `/events?since=<state.seq>` after reading state must
    // not be replayed frames whose effect the state it just read already
    // contains, and must not miss any that landed after.
    doc.seq = kortixEventBus().headSeq
    if (!this.etag) this.etag = etagOf(doc)
    return { doc, etag: this.etag, readMs: performance.now() - t0 }
  }

  private async rebuild(): Promise<void> {
    const sections = new Set(this.dirty)
    this.dirty.clear()
    const base = this.doc
    const url = this.deps.opencode.getInternalUrl()
    const workspace = this.deps.cfg.workspace || '/workspace'
    const dir = `directory=${encodeURIComponent(workspace)}`

    const catalog = sections.has('catalog') || !base
    const sessions = sections.has('sessions') || !base
    const live = sections.has('live') || !base

    const [
      agentsRes,
      commandsRes,
      configRes,
      healthRes,
      sessionsRes,
      statusRes,
      permissionRes,
      questionRes,
      buildRes,
    ] = await Promise.allSettled([
      catalog ? readJson(`${url}/agent?${dir}`) : Promise.resolve(null),
      catalog ? readJson(`${url}/command?${dir}`) : Promise.resolve(null),
      catalog ? readJson(`${url}/config?${dir}`) : Promise.resolve(null),
      catalog || !base ? readJson(`${url}/global/health`) : Promise.resolve(null),
      sessions ? this.readSessions(url, dir) : Promise.resolve(null),
      live ? readJson(`${url}/session/status?${dir}`) : Promise.resolve(null),
      live ? readJson(`${url}/permission?${dir}`) : Promise.resolve(null),
      live ? readJson(`${url}/question?${dir}`) : Promise.resolve(null),
      Promise.resolve(this.deps.daemonBuild()),
    ])

    const section = <T>(
      rebuild: boolean,
      settled: PromiseSettledResult<unknown>,
      previous: Known<T> | undefined,
      project: (raw: unknown) => T,
      empty: T,
    ): Known<T> => {
      if (!rebuild) return previous ?? unknownSection('never built', empty)
      if (settled.status === 'rejected') {
        const reason = `opencode read failed: ${(settled.reason as Error)?.message ?? 'unknown'}`
        // A failed read NEVER downgrades a projection we already hold: the last
        // true state beats "unknown", and `built_at` shows its age.
        return previous ?? unknownSection(reason, empty)
      }
      return known(project(settled.value))
    }

    const version =
      healthRes.status === 'fulfilled' && healthRes.value
        ? ((healthRes.value as { version?: unknown }).version as string | undefined) ?? null
        : base?.identity.opencode_version ?? null

    const doc: RuntimeStateDoc = {
      epoch: kortixEventBus().epoch,
      seq: kortixEventBus().headSeq,
      built_at: new Date(this.now()).toISOString(),
      identity: {
        opencode_session_id: this.deps.pinnedSessionId(),
        opencode_version: version,
        daemon_build:
          buildRes.status === 'fulfilled' ? ((buildRes.value as number | null) ?? null) : null,
        agent_config_etag: process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG || null,
        head_seq: this.deps.db.probe().supported ? this.deps.db.headSeqs() : null,
      },
      agents: section(catalog, agentsRes, base?.agents, projectAgents, []),
      commands: section(catalog, commandsRes, base?.commands, projectCommands, []),
      config: section(catalog, configRes, base?.config, projectConfig, {
        model: null,
        small_model: null,
        default_agent: null,
        permission: null,
        instructions: null,
        enabled_providers: null,
      }),
      sessions: section(
        sessions,
        sessionsRes,
        base?.sessions,
        (raw) => raw as SessionProjection[],
        [],
      ),
      statuses: section(live, statusRes, base?.statuses, projectStatuses, {}),
      permissions: section(live, permissionRes, base?.permissions, projectPermissions, []),
      questions: section(live, questionRes, base?.questions, projectQuestions, []),
    }

    this.doc = doc
    this.etag = null
    this.builtAtMs = this.now()
  }

  /**
   * The session list, from `opencode.db` when the shape is verified and from
   * OpenCode's HTTP otherwise.
   *
   * SQLite first on purpose: the session row is one of the two facts that must
   * be answerable while OpenCode is mid-turn or dead (the other is the event
   * cursor), and a 0.03 ms indexed read beats a 3 ms loopback that a wedged
   * OpenCode may not answer at all.
   */
  private async readSessions(url: string, dir: string): Promise<SessionProjection[]> {
    const probe = this.deps.db.probe()
    if (probe.supported && isSupportedOpencodeVersion(await this.opencodeVersion())) {
      const rows = this.deps.db.sessions()
      if (rows) return projectSessionRows(rows)
    }
    return projectSessions(await readJson(`${url}/session?${dir}`))
  }

  /**
   * The running OpenCode's self-reported version, memoised.
   *
   * Read separately from {@link read} because the transcript route needs it on
   * a cold call — before any `/state` has been served — and must not trigger a
   * full catalog rebuild to learn it. `GET /global/health` is a 3 ms loopback
   * read; once answered it is cached for the life of the process, and an
   * OpenCode replacement restarts that process's view via the catalog
   * invalidation on `server.instance.disposed`.
   */
  async opencodeVersion(): Promise<string | null> {
    if (this.doc?.identity.opencode_version) return this.doc.identity.opencode_version
    if (this.versionProbe) return this.versionProbe
    this.versionProbe = (async () => {
      try {
        const body = (await readJson(`${this.deps.opencode.getInternalUrl()}/global/health`, 3_000)) as {
          version?: unknown
        }
        return typeof body?.version === 'string' ? body.version : null
      } catch {
        // Unreadable is NOT the same as mismatched, and it converges nothing:
        // the caller treats null as "cannot verify" and takes the HTTP path.
        this.versionProbe = null
        return null
      }
    })()
    return this.versionProbe
  }

  __docForTests(): RuntimeStateDoc | null {
    return this.doc
  }
}

// ---------------------------------------------------------------------------
// Process singleton
// ---------------------------------------------------------------------------

let store: RuntimeStateStore | null = null

export function configureRuntimeState(deps: RuntimeStateDeps): RuntimeStateStore {
  store = new RuntimeStateStore(deps)
  return store
}

export function runtimeStateStore(): RuntimeStateStore | null {
  return store
}

/**
 * Invalidate from anywhere — `routes/env.ts` after it applies env and respawns
 * OpenCode, `opencode.ts` after a verified reload promotes the standby half.
 * A no-op before the store is configured, so a boot-time caller is safe.
 */
export function invalidateRuntimeState(
  section: RuntimeStateSection | 'all',
  reason: string,
): void {
  store?.invalidate(section, reason)
}

export function resetRuntimeStateForTests(): void {
  store = null
}
