/**
 * Projections: the exact fields the product reads, and nothing else.
 *
 * WHY. Measured on a live box (WS-V §3.5), the OpenCode payloads the session
 * open pays for are the wrong shape by two orders of magnitude:
 *
 *   | endpoint  | raw       | projected | projected+gzip | shrink        |
 *   |-----------|-----------|-----------|----------------|---------------|
 *   | /agent    |   139,357 |     2,400 |            932 |   58x / 150x  |
 *   | /command  |   588,644 |    19,193 |          7,370 |   31x /  80x  |
 *   | /config   | 2,615,657 |       220 |            163 | 11,889x / 16,047x |
 *   | total     | 3,343,658 |    21,813 |          8,206 |  153x / 407x  |
 *
 * `/agent` is 139 KB because every agent carries its 10-20 KB system prompt;
 * the composer renders `name`, `description`, `mode`. `/config` is 2.6 MB
 * because `config.provider` is 2,605,270 B of model catalog (99.94% of the
 * body); the UI reads `config.model` — 26 bytes.
 *
 * EVERY function here is PURE. They take whatever OpenCode returned and give
 * back the projection; an unexpected shape yields fewer fields, never a throw.
 * The routes that call them are thin.
 *
 * TWO INVARIANTS, both learned the hard way in this repo:
 *
 *  - **Ids are VERBATIM.** Message ids, part ids, agent names, command names,
 *    permission ids and question ids come out exactly as OpenCode produced
 *    them. Never synthesised, never renamed. A cached record whose id the live
 *    read will not also produce is a ghost — the rule
 *    `session-transcript-mirror.ts:34-38` exists for, and the reason the last
 *    mirror had to be deleted.
 *  - **Attachment bytes never travel.** A projected part references
 *    `/kortix/part/:session/:message/:part` and the sidecar serves the bytes on
 *    demand. Twenty messages weighed 7-19 MB on Essentia (2026-08-24) and
 *    several reads died on the browser's 30 s deadline; the same read served
 *    in-VM took 276 ms. The cost was entirely the bytes leaving.
 */
import { stripInlineAttachmentBytes } from './inline-attachments'

// ---------------------------------------------------------------------------
// State projection — the seven reads `/kortix/opencode/state` replaces
// ---------------------------------------------------------------------------

export interface AgentProjection {
  name: string
  description: string | null
  mode: string | null
  /** OpenCode's own flag: a built-in agent rather than one from config. */
  native: boolean | null
  hidden: boolean | null
  color: string | null
  variant: string | null
  /** Derived from `native`, the word the product uses: 'builtin' | 'config'. */
  source: 'builtin' | 'config' | null
  model: { providerID: string; modelID: string } | null
}

export interface CommandProjection {
  name: string
  description: string | null
  agent: string | null
  model: string | null
  source: string | null
  subtask: boolean | null
  hints: string[]
  /**
   * The template's SIZE, not the template. A `/` menu renders names; only the
   * ONE command a user invokes needs its body, and that read is a separate,
   * user-initiated call. 39 commands = 575 KB of templates on the live box.
   */
  template_bytes: number
}

export interface ConfigProjection {
  model: string | null
  small_model: string | null
  default_agent: string | null
  /** OpenCode's default permission ruleset — `{edit: 'allow'}` and friends. */
  permission: Record<string, unknown> | null
  instructions: string[] | null
  enabled_providers: string[] | null
}

export interface SessionProjection {
  id: string
  title: string
  parent_id: string | null
  directory: string | null
  time: { created: number; updated: number; compacting: number | null }
  /** Present only when the session has a staged revert. */
  revert: unknown | null
}

export interface PermissionProjection {
  id: string
  sessionID: string
  permission: string | null
  patterns: string[]
  tool: { messageID: string; callID: string } | null
}

export interface QuestionProjection {
  id: string
  sessionID: string
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * OpenCode answers `/agent` as an array on some builds and a name-keyed object
 * on others (the SDK's own `agents.ts` handles both). Normalise once, here.
 */
function asList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') return Object.values(payload as Record<string, unknown>)
  return []
}

export function projectAgents(payload: unknown): AgentProjection[] {
  const out: AgentProjection[] = []
  for (const raw of asList(payload)) {
    if (!raw || typeof raw !== 'object') continue
    const agent = raw as Record<string, unknown>
    const name = str(agent.name)
    if (!name) continue
    const native = bool(agent.native)
    const model = agent.model as { providerID?: unknown; modelID?: unknown } | undefined
    out.push({
      name,
      description: str(agent.description),
      mode: str(agent.mode),
      native,
      hidden: bool(agent.hidden),
      color: str(agent.color),
      variant: str(agent.variant),
      source: native === null ? null : native ? 'builtin' : 'config',
      model:
        model && typeof model.providerID === 'string' && typeof model.modelID === 'string'
          ? { providerID: model.providerID, modelID: model.modelID }
          : null,
    })
  }
  return out
}

export function projectCommands(payload: unknown): CommandProjection[] {
  const out: CommandProjection[] = []
  for (const raw of asList(payload)) {
    if (!raw || typeof raw !== 'object') continue
    const command = raw as Record<string, unknown>
    const name = str(command.name)
    if (!name) continue
    out.push({
      name,
      description: str(command.description),
      agent: str(command.agent),
      model: str(command.model),
      source: str(command.source),
      subtask: bool(command.subtask),
      hints: strArray(command.hints),
      template_bytes: typeof command.template === 'string' ? command.template.length : 0,
    })
  }
  return out
}

export function projectConfig(payload: unknown): ConfigProjection {
  const config = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const permission = config.permission
  const provider = config.provider
  return {
    model: str(config.model),
    small_model: str(config.small_model),
    default_agent: str(config.agent) ?? str(config.default_agent),
    permission:
      permission && typeof permission === 'object' && !Array.isArray(permission)
        ? (permission as Record<string, unknown>)
        : null,
    instructions: Array.isArray(config.instructions) ? strArray(config.instructions) : null,
    // The NAMES only. `config.provider` is the 2.6 MB model catalog; the
    // product asks one question of it — "which providers are on".
    enabled_providers:
      provider && typeof provider === 'object' && !Array.isArray(provider)
        ? Object.keys(provider as Record<string, unknown>)
        : null,
  }
}

/** From OpenCode's HTTP `/session` list. */
export function projectSessions(payload: unknown): SessionProjection[] {
  const out: SessionProjection[] = []
  for (const raw of asList(payload)) {
    if (!raw || typeof raw !== 'object') continue
    const session = raw as Record<string, unknown>
    const id = str(session.id)
    if (!id) continue
    const time = (session.time ?? {}) as Record<string, unknown>
    out.push({
      id,
      title: str(session.title) ?? '',
      parent_id: str(session.parentID),
      directory: str(session.directory),
      time: {
        created: typeof time.created === 'number' ? time.created : 0,
        updated: typeof time.updated === 'number' ? time.updated : 0,
        compacting: typeof time.compacting === 'number' ? time.compacting : null,
      },
      revert: session.revert ?? null,
    })
  }
  return out
}

/**
 * From `opencode.db`'s `session` rows — the same projection, from the source
 * that answers while OpenCode is mid-turn or dead. Column names are snake_case
 * there and the JSON shape is nested; this is the one place that bridges them.
 */
export function projectSessionRows(
  rows: Array<{
    id: string
    title: string
    directory: string
    parent_id: string | null
    time_created: number
    time_updated: number
    time_compacting: number | null
    revert: string | null
  }>,
): SessionProjection[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? '',
    parent_id: row.parent_id ?? null,
    directory: row.directory ?? null,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? null,
    },
    revert: row.revert ? safeJson(row.revert) : null,
  }))
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

/** `GET /session/status` answers `{ [sessionID]: SessionStatus }`. */
export function projectStatuses(payload: unknown): Record<string, { type: string }> {
  const out: Record<string, { type: string }> = {}
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out
  for (const [sessionId, value] of Object.entries(payload as Record<string, unknown>)) {
    const type = str((value as { type?: unknown } | undefined)?.type)
    if (type) out[sessionId] = { type }
  }
  return out
}

export function projectPermissions(payload: unknown): PermissionProjection[] {
  const out: PermissionProjection[] = []
  for (const raw of asList(payload)) {
    if (!raw || typeof raw !== 'object') continue
    const permission = raw as Record<string, unknown>
    const id = str(permission.id)
    const sessionID = str(permission.sessionID)
    if (!id || !sessionID) continue
    const tool = permission.tool as { messageID?: unknown; callID?: unknown } | undefined
    out.push({
      id,
      sessionID,
      permission: str(permission.permission),
      patterns: strArray(permission.patterns),
      tool:
        tool && typeof tool.messageID === 'string' && typeof tool.callID === 'string'
          ? { messageID: tool.messageID, callID: tool.callID }
          : null,
    })
  }
  return out
}

/**
 * Questions project to `id` + `sessionID` only.
 *
 * The BODY of a pending question (its prompt and options) arrives on the
 * `question.asked` frame and is already relayed to the control plane
 * (`relayQuestionToApi`). What the client needs from state is the SET of
 * questions still open — the thing the deleted 2 s `/question` self-heal poll
 * was asking for. `sessionID` rides along because routing an answer needs it
 * and it costs 30 bytes.
 */
export function projectQuestions(payload: unknown): QuestionProjection[] {
  const out: QuestionProjection[] = []
  for (const raw of asList(payload)) {
    if (!raw || typeof raw !== 'object') continue
    const question = raw as Record<string, unknown>
    const id = str(question.id)
    if (!id) continue
    out.push({ id, sessionID: str(question.sessionID) ?? '' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Message projection — what `/kortix/opencode/messages/:sessionId` serves
// ---------------------------------------------------------------------------

/**
 * Fields of `info` the transcript renders. Everything else on an
 * AssistantMessage (`path`, `structured`, `system`, `tools`) is either
 * box-local or unread by any consumer.
 */
const MESSAGE_INFO_FIELDS = [
  'id',
  'sessionID',
  'role',
  'time',
  'agent',
  'model',
  'modelID',
  'providerID',
  'variant',
  'mode',
  'parentID',
  'cost',
  'tokens',
  'error',
  'finish',
  'summary',
] as const

/** Part fields kept for every part type. `state` is handled per tool below. */
const PART_COMMON_FIELDS = [
  'id',
  'sessionID',
  'messageID',
  'type',
  'text',
  'synthetic',
  'ignored',
  'time',
  'mime',
  'filename',
  'url',
  // The offload marker. Without it the stripper can still recognise a moved
  // attachment by its 1x1 placeholder url, but the marker is the direct signal
  // and it carries the real byte count the UI shows before fetching.
  'kortix',
  'source',
  'callID',
  'tool',
  'snapshot',
  'reason',
  'cost',
  'tokens',
  'hash',
  'files',
  'name',
  'attempt',
  'error',
  'auto',
  'overflow',
  'tail_start_id',
  'prompt',
  'description',
  'agent',
  'model',
  'command',
] as const

/**
 * A tool part's `state.metadata` is unbounded — a browser tool writes its whole
 * DOM snapshot there, a bash tool its environment. The renderer reads
 * `status`, `title`, `input`, `output`, `error`, `time`. `metadata` is kept
 * ONLY when it is small; past the cap it is replaced by its size so the UI can
 * still say "there is more" and fetch the raw part if it ever needs to.
 */
export const TOOL_METADATA_MAX_BYTES = 4 * 1024
/** Tool `output` past this is truncated with an explicit marker. */
export const TOOL_OUTPUT_MAX_BYTES = 64 * 1024

export interface ProjectedTranscript {
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  /** Attachment payloads swapped for `/kortix/part/...` refs. */
  stripped: number
  savedBytes: number
  /** Tool outputs truncated, and by how many bytes. */
  truncated: number
  truncatedBytes: number
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field]
  }
  return out
}

export function projectMessageInfo(info: Record<string, unknown>): Record<string, unknown> {
  return pick(info, MESSAGE_INFO_FIELDS)
}

export function projectPart(part: Record<string, unknown>): Record<string, unknown> {
  const out = pick(part, PART_COMMON_FIELDS)
  const state = part.state
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const raw = state as Record<string, unknown>
    const projected: Record<string, unknown> = pick(raw, [
      'status',
      'title',
      'input',
      'output',
      'error',
      'time',
      'attachments',
    ])
    const metadata = raw.metadata
    if (metadata !== undefined) {
      const size = JSON.stringify(metadata)?.length ?? 0
      if (size <= TOOL_METADATA_MAX_BYTES) projected.metadata = metadata
      else projected.metadata_bytes = size
    }
    out.state = projected
  }
  return out
}

/**
 * Project a page of `{info, parts}` for the wire.
 *
 * Order of operations matters: parts are projected FIRST (so a tool's oversized
 * metadata is gone before anything walks it), then the attachment stripper runs
 * over the result so every remaining `data:` payload becomes a
 * `/kortix/part/...` reference.
 */
export function projectTranscript(
  page: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>,
  sessionId: string,
): ProjectedTranscript {
  let truncated = 0
  let truncatedBytes = 0
  const projected = page.map((entry) => ({
    info: projectMessageInfo(entry.info),
    parts: entry.parts.map((part) => {
      const next = projectPart(part)
      const state = next.state as Record<string, unknown> | undefined
      if (state && typeof state.output === 'string' && state.output.length > TOOL_OUTPUT_MAX_BYTES) {
        truncated++
        truncatedBytes += state.output.length - TOOL_OUTPUT_MAX_BYTES
        state.output = `${state.output.slice(0, TOOL_OUTPUT_MAX_BYTES)}\n… [kortix: truncated ${state.output.length - TOOL_OUTPUT_MAX_BYTES} bytes]`
        state.output_truncated = true
      }
      return next
    }),
  }))

  const result = stripInlineAttachmentBytes(
    projected,
    (messageId, partId) =>
      `/kortix/part/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}`,
  )
  return {
    messages: result.value as ProjectedTranscript['messages'],
    stripped: result.stripped,
    savedBytes: result.savedBytes,
    truncated,
    truncatedBytes,
  }
}

// ---------------------------------------------------------------------------
// Etag
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted at every depth, so a rebuild that
 * produces the same facts in a different key order does NOT invalidate a
 * client's cache. Arrays keep their order — it is meaningful.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function etagOf(value: unknown): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(canonicalJson(value))
  return `"sha256-${hasher.digest('hex').slice(0, 32)}"`
}
