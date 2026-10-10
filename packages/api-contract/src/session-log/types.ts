/**
 * Ported from the tested prototype (schema/session-v2.1.ts; 65 of 65 restores across 7 sources
 * and 5 target harnesses). Only the record names differ (decision D1): Session, Thread,
 * Message and Block are SessionLog, SessionLogThread, SessionLogMessage and SessionLogBlock.
 * This file has no imports, so it can be copied as is.
 *
 * kortix.session/2 — minor 1 (DRAFT 2.1). Additive over 2.0; a 2.0 reader still
 * reads every 2.1 record (new fields are optional; new layout entries carry text).
 *
 * Changes from 2.0, each found by a harness test (pi, OpenCode v1, OpenCode v2,
 * Claude Code, Codex — see the report):
 *  C1  CompactionBlock: `layout` (explicit post-cut order), nullable/opaque summary, optional trigger
 *  C2  ToolCallBlock: input_format, result.model_content / error / exit_code / synthetic; closure rule
 *  C3  ReasoningBlock: replay rule (never replay across provider/model)
 *  C4  AttachmentBlock: label, source_path; attachments allowed in tool results (model-visible)
 *  C5  Message: agent, reply_to, parent_message_id, origin 'notification', hidden_reason 'aborted'
 *  C6  ModelRef.api (wire dialect) separate from provider
 *  C7  ids are opaque; adapters keep native id maps in ext[harness].native_id
 *  C8  Thread: nickname, interactions (async sub-agents); SubtaskBlock.call_ids
 *  C9  Todo.id and priority optional; pending is best-effort
 *  C10 TextBlock.synthetic defined; multi-part text = concatenation
 *  C11 context messages may reference a deduplicated blob
 *  C12 Capabilities: each adapter declares what it can render natively (switch preflight)
 *  C13 Export is incremental and hash-guarded (never re-derive a restored record from a lossy native store)
 *
 * Unchanged rules from 2.0: model-visible vs display split, explicit context
 * operations, order by seq, mutability only while streaming, harness-unique data
 * only in ext[harness] or a harness block with fallback_text, and versioning.
 */

export const SESSION_LOG_SCHEMA = 'kortix.session/2' as const
export const SESSION_LOG_MINOR = 1
export type SchemaRef = { schema: typeof SESSION_LOG_SCHEMA; v: number }

/** Harness-unique data, keyed by harness id. `native_id` (C7) maps this record to the harness's own id. */
export type Ext = Record<string, { version: string; native_id?: string; data?: unknown }>
export type Producer = { harness: string; harness_version: string; adapter_version: string }

/** C6: provider = who serves the model; api = the wire dialect the harness spoke. */
export type ModelRef = {
  provider: string
  model: string
  api?: 'anthropic-messages' | 'openai-chat' | 'openai-responses' | (string & {})
  variant?: string
  reasoning_effort?: string
}

export type Todo = { id?: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority?: 'high' | 'medium' | 'low' }
/** C9: best-effort — a target harness may be unable to re-arm a pending question/permission. Shape unchanged from 2.0 (a minor must not change a shape). */
export type Pending = { id: string; thread_id: string; call_id?: string; payload: unknown; asked_at: string }

export type SessionLog = SchemaRef & {
  session_id: string
  title: string | null
  created_at: string
  harness: { current: string; history: Array<{ harness: string; version: string; from_seq: number; at: string }> }
  selection: { agent: string | null; model: ModelRef | null }
  todos: Todo[]
  pending: { questions: Pending[]; permissions: Pending[] }
  threads: SessionLogThread[]
  ext?: Ext
}

/** C8: async sub-agents (Codex spawn/wait/send/close/resume) as well as synchronous task calls. */
export type ThreadInteraction = { message_id: string; call_id: string; op: 'spawn' | 'send' | 'wait' | 'close' | 'resume' | 'result' }

export type SessionLogThread = SchemaRef & {
  thread_id: string
  parent_thread_id: string | null
  spawned_by: { message_id: string; call_id: string } | null
  interactions?: ThreadInteraction[]
  agent: string | null
  nickname?: string | null
  title: string | null
  created_at: string
  messages: SessionLogMessage[]
  ext?: Ext
}

export type Role = 'user' | 'assistant' | 'system'

export type SessionLogMessage = SchemaRef & {
  message_id: string                                    // C7: opaque, unique within the session
  thread_id: string
  seq: number
  role: Role
  kind: 'turn' | 'compaction' | 'context'
  status: 'streaming' | 'complete' | 'error' | 'aborted' | 'interrupted'
  in_context: boolean
  hidden_reason?: 'failed_attempt' | 'aborted' | 'retracted' | 'reverted' | 'superseded'
  origin?: 'prompt' | 'steer' | 'command' | 'automation' | 'subagent' | 'notification'
  agent?: string | null                                 // C5: agent that produced/received this step
  reply_to?: string | null                              // C5: the user message an assistant step answers
  parent_message_id?: string | null                     // C5: transcript trees (display; the model sees the active branch)
  model: ModelRef | null                                // optional/derived on user messages
  usage: Usage | null
  finish: 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted' | null
  error: { code: string; message: string } | null
  created_at: string
  completed_at: string | null
  producer: Producer
  blocks: SessionLogBlock[]
  /** C11: a context message may store its body as a deduplicated blob instead of blocks. */
  context_ref?: string
  ext?: Ext
}

export type Usage = { input: number; output: number; cache_read: number; cache_write: number; reasoning?: number; cost?: number }

export type SessionLogBlock = TextBlock | ReasoningBlock | AttachmentBlock | ToolCallBlock | CompactionBlock | SubtaskBlock | StepBlock | HarnessBlock

/**
 * model: `model_text ?? text`. Several text blocks in one message are seen by the
 * model as their concatenation (harnesses join with "" or "\n").
 * C10: synthetic = generated by the harness (reminders, image source lines,
 * command caveats); model-visible in that harness; a foreign restore may drop it.
 */
export type TextBlock = { type: 'text'; text: string; model_text?: string; synthetic?: boolean; ext?: Ext }

/**
 * Display only. C3: a restore MUST NOT hand a reasoning block to a target whose
 * (provider, model) differs from the block's message model — pi, OpenCode v1 and
 * OpenCode v2 would replay it as visible text. Same-provider continuation data
 * (signatures, encrypted_content) lives in ext[harness].
 */
export type ReasoningBlock = { type: 'reasoning'; text: string; summary?: string[]; redacted?: boolean; ext?: Ext }

/** model: the bytes behind `ref`. C4: label/source_path are display (Codex "[Image #1]", Claude "[Image: source: …]"). */
export type AttachmentBlock = {
  type: 'attachment'
  ref: string
  mime: string
  name?: string
  label?: string
  source_path?: string
  bytes: number
  sha256: string
  ext?: Ext
}

export type ToolKind =
  | 'shell' | 'read' | 'write' | 'edit' | 'patch' | 'list' | 'glob' | 'grep'
  | 'web_fetch' | 'web_search' | 'todo' | 'task' | 'question' | 'plan' | 'mcp' | 'other'

export type ToolResultContent = { type: 'text'; text: string } | { type: 'attachment'; ref: string; mime: string; sha256?: string }

/**
 * C2. model: call_id, name, input, and `result.model_content ?? result.content`.
 * Rule: a thread AT REST has no in-context call without a result — an exporter
 * closes an interrupted call with `{ is_error: true, synthetic: true }` and the
 * text the harness showed (pi "No result provided", OpenCode "[Tool execution was
 * interrupted]"), or "[interrupted]" if the harness showed nothing.
 */
export type ToolCallBlock = {
  type: 'tool_call'
  call_id: string
  name: string
  kind: ToolKind
  input: unknown
  input_format?: 'json' | 'text'                        // text = freeform input (Codex custom tools); object-only harnesses wrap {input: …}
  status: 'pending' | 'running' | 'complete' | 'error'
  result?: {
    content: ToolResultContent[]                        // what the tool returned (display)
    model_content?: ToolResultContent[]                 // what the model saw when it differs (pruned, envelope, edited)
    is_error: boolean                                   // the call failed (model-visible only where the dialect has an error channel)
    error?: { code?: string; message: string }          // semantic error, independent of rendering
    exit_code?: number                                  // display
    synthetic?: boolean                                 // closed by the harness/adapter, not by the tool
    cleared_at?: string                                 // output pruned from the model's context at this time
    details?: unknown                                   // harness-neutral structured display data only; harness data goes to ext
  }
  title?: string
  started_at?: string
  ended_at?: string
  ext?: Ext
}

/**
 * C1. The model sees, in place of every in-context message before this marker:
 *  - with `layout`: exactly the listed entries, in order;
 *  - without `layout`: [summary, …messages from first_kept_message_id up to the marker].
 * `summary: null` + `opaque: true` = a provider-encrypted compaction (OpenAI remote
 * compaction); only the same provider can replay it (ext), another harness
 * restores the layout's kept messages without a summary.
 */
export type CompactionLayoutEntry =
  | { summary: true }
  | { message_id: string; text_only?: boolean }
  | { text: string }                                    // kept context serialized as text (OpenCode v2 recent-context)

export type CompactionBlock = {
  type: 'compaction'
  summary: string | null
  opaque?: boolean
  first_kept_message_id: string | null
  layout?: CompactionLayoutEntry[]
  tokens_before?: number
  trigger?: 'auto' | 'manual' | 'overflow' | 'unknown'
  ext?: Ext
}

export type SubtaskBlock = { type: 'subtask'; thread_id: string; agent: string; description: string; call_id?: string; call_ids?: string[] }
export type StepBlock = { type: 'step'; phase: 'start' | 'finish'; ext?: Ext }
export type HarnessBlock = { type: 'harness'; harness: string; kind: string; data: unknown; model_visible: boolean; fallback_text?: string }

/**
 * C12. What an adapter can render natively. A mid-session switch runs a preflight:
 * every feature the session uses that the target lacks becomes a line in the
 * loss report shown before the switch.
 */
export type AdapterCapabilities = {
  harness: string
  harness_versions: string                              // semver range the adapter is tested against
  schema_minors: number[]                               // minors it reads
  dialects: Array<NonNullable<ModelRef['api']>>
  tool_error_channel: boolean                           // can the model see is_error?
  attachments: { user: string[]; tool_result: boolean } // mime types natively deliverable
  compaction: Array<'summary_first_tail' | 'layout' | 'text_tail' | 'opaque'>
  subagents: 'none' | 'sync' | 'async'
  todos: boolean
  reasoning_replay: 'none' | 'same_model' | 'lowers_to_text'
  freeform_tool_input: boolean
}

/**
 * C13. Export is incremental and hash-guarded: after a restore, an adapter
 * emits only messages that are new, or whose model-visible content changed
 * (hash of the native rendering). A restored record is never re-derived from a
 * lossy native store. (In the prototype every adapter needed a "sidecar" in its
 * native store to pass round trips; with the database as source of truth the
 * sidecar disappears and this rule replaces it.)
 */
export type ExportCursor = { thread_id: string; last_seq: number; native_hashes: Record<string, string> }
