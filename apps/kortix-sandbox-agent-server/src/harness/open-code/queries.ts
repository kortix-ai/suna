import { existsSync, readFileSync } from 'node:fs'
import type {
  HarnessActionResult,
  HarnessAttachmentService,
  HarnessQueryFactory,
  HarnessQueryService,
  HarnessReadResult,
} from '../queries'
import type { OpenCodeConfig } from './config'
import { requireOpenCodeConfig } from './config'
import type { Opencode } from './lifecycle'
import { OpencodeDb, isSupportedOpencodeVersion } from './opencode-db'
import { projectTranscript } from './opencode-projection'
import { configureRuntimeState, runtimeStateStore, type RuntimeStateStore } from './runtime-state-projection'
import { kortixEventBus } from '../../kortix-event-bus'
import { OPENCODE_EVENT_RECOVERY } from './event-bus'
import { readOpenCodeSessionPin } from './runtime-state'
import { observeRequestedTurn, resolveTurnObservationIdentity } from './diagnostics'
import { runtimeConvergenceReport } from '../../runtime-assets'
import { OPENCODE_HOME } from './paths'
import {
  defaultSidecarDir,
  opencodeDbPath,
  inlineAttachmentsOf,
  isOffloadPlaceholder,
  sidecarPathFor,
  type AttachmentLike,
} from './attachment-offload'
import { logger } from '../../logger'

interface OpenCodeQueryOptions {
  db?: OpencodeDb
  state?: RuntimeStateStore
  pinnedSessionId?: () => string | null
  sidecarDir?: string | null
}

/** Native reads and actions. HTTP controllers consume the returned data only. */
export function createOpenCodeQueryService(
  opencode: Opencode,
  options: OpenCodeQueryOptions = {},
): HarnessQueryFactory {
  return {
    bind({ cfg }) {
      const native = requireOpenCodeConfig(cfg)
      const db = options.db ?? new OpencodeDb(opencodeDbPath(OPENCODE_HOME))
      const pinnedSessionId = options.pinnedSessionId ?? readOpenCodeSessionPin
      const state =
        options.state ??
        runtimeStateStore() ??
        configureRuntimeState({
          opencode,
          cfg: native,
          db,
          pinnedSessionId,
          daemonBuild: async () => (await runtimeConvergenceReport()).build,
        })
      return bindQueries(opencode, native, db, state, pinnedSessionId, options.sidecarDir)
    },
  }
}

function bindQueries(
  opencode: Opencode,
  cfg: OpenCodeConfig,
  db: OpencodeDb,
  state: RuntimeStateStore,
  pinnedSessionId: () => string | null,
  sidecarDir: string | null | undefined,
): HarnessQueryService {
  const workspace = () => cfg.workspace || process.env.KORTIX_WORKSPACE || '/workspace'
  const read = async (path: string, extraQuery = ''): Promise<HarnessReadResult> => {
    const qs = [`directory=${encodeURIComponent(workspace())}`, extraQuery].filter(Boolean).join('&')
    try {
      const res = await fetch(`${opencode.getInternalUrl()}${path}?${qs}`, {
        signal: AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      return {
        ok: true,
        upstreamStatus: res.status,
        contentType: res.headers.get('content-type') ?? 'application/json',
        text,
      }
    } catch (err) {
      return {
        ok: false,
        body: { error: 'opencode read failed', detail: err instanceof Error ? err.message : String(err) },
      }
    }
  }
  const act = async (
    kind: string,
    sessionId: string | null,
    path: string,
    payload: unknown,
  ): Promise<HarnessActionResult> => {
    const dir = `directory=${encodeURIComponent(workspace())}`
    try {
      const res = await fetch(`${opencode.getInternalUrl()}${path}${path.includes('?') ? '&' : '?'}${dir}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      if (!res.ok) {
        logger.warn('[kortix-runtime] act forward failed', { kind, path, status: res.status })
        return {
          ok: false,
          reason: res.status === 404 ? 'not-found' : 'upstream',
          body: { ok: false, kind, error: `opencode ${res.status}`, detail: text.slice(0, 300) },
        }
      }
      return { ok: true, body: { ok: true, kind, session_id: sessionId, seq: kortixEventBus().headSeq } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[kortix-runtime] act threw', { kind, path, error: message })
      return { ok: false, reason: 'upstream', body: { ok: false, kind, error: message } }
    }
  }
  const noSession = (): HarnessActionResult => ({
    ok: false,
    reason: 'no-session',
    body: { ok: false, error: 'no opencode session pinned' },
  })
  return {
    readState: () => state.read(),
    async readMessages({ sessionId, limit, before, after, afterSeq }) {
      const version = await state.opencodeVersion()
      const probe = db.probe()
      const useDb = probe.supported && isSupportedOpencodeVersion(version)

      let page: Awaited<ReturnType<OpencodeDb['messagePage']>> = null
      let source: 'sqlite' | 'opencode-http' = 'sqlite'
      const readStart = performance.now()
      if (useDb) {
        page = db.messagePage({
          sessionId,
          limit,
          after,
          before,
          afterSeq,
        })
      }
      if (!page) {
        source = 'opencode-http'
        const fallback = await readMessagesOverHttp(opencode, workspace(), sessionId, {
          limit,
          before,
        })
        if (!fallback.ok) {
          return {
            ok: false,
            body: {
              error: 'transcript unreadable',
              source,
              detail: fallback.detail,
              db: {
                supported: probe.supported,
                reason: probe.reason,
                version_supported: isSupportedOpencodeVersion(version),
              },
            },
          }
        }
        page = { messages: fallback.messages, dropped: 0, hasMore: fallback.messages.length >= limit }
      }
      const readMs = performance.now() - readStart

      const projected = projectTranscript(page.messages, sessionId)
      const first = projected.messages[0]?.info as { id?: string } | undefined
      const last = projected.messages[projected.messages.length - 1]?.info as { id?: string } | undefined
      const body = {
        session_id: sessionId,
        epoch: kortixEventBus().epoch,
        /** Stream cursor to resume from: everything in this page is already applied. */
        seq: kortixEventBus().headSeq,
        /** OpenCode's own durable cursor for this session, for `?after_seq=`. */
        head_seq: useDb ? db.headSeq(sessionId) : null,
        source,
        count: projected.messages.length,
        has_more: page.hasMore,
        /** Page bounds, ids VERBATIM from OpenCode — a mirror can key on them. */
        first_message_id: first?.id ?? null,
        last_message_id: last?.id ?? null,
        dropped: page.dropped,
        attachments_referenced: projected.stripped,
        attachment_bytes_saved: projected.savedBytes,
        tool_outputs_truncated: projected.truncated,
        messages: projected.messages,
      }
      if (page.dropped > 0) {
        logger.warn('[kortix-runtime] dropped unparseable transcript rows', {
          sessionId,
          dropped: page.dropped,
        })
      }
      return { ok: true, body, source, readMs }
    },
    readVcsDiff: (mode) => read('/vcs/diff', mode ? `mode=${encodeURIComponent(mode)}` : ''),
    readCurrentProject: () => read('/project/current'),
    readConfiguration: () => read('/config'),
    readSession: (sessionId) => read(`/session/${encodeURIComponent(sessionId)}`),
    readTodo: (sessionId) => read(`/session/${encodeURIComponent(sessionId)}/todo`),
    pinnedSessionId,
    replyPermission: ({ id, reply, message, sessionId }) =>
      act('permission', sessionId, `/permission/${encodeURIComponent(id)}/reply`, {
        reply,
        ...(typeof message === 'string' ? { message } : {}),
      }),
    replyQuestion: ({ id, answers, sessionId }) =>
      act('question', sessionId, `/question/${encodeURIComponent(id)}/reply`, { answers }),
    rejectQuestion: ({ id, sessionId }) =>
      act('question', sessionId, `/question/${encodeURIComponent(id)}/reject`, {}),
    stopSession: async (sessionId) =>
      sessionId ? act('stop', sessionId, `/session/${encodeURIComponent(sessionId)}/abort`, {}) : noSession(),
    revertSession: async ({ sessionId, messageId, partId }) =>
      sessionId
        ? act('revert', sessionId, `/session/${encodeURIComponent(sessionId)}/revert`, {
            messageID: messageId,
            ...(typeof partId === 'string' ? { partID: partId } : {}),
          })
        : noSession(),
    unrevertSession: async (sessionId) =>
      sessionId
        ? act('revert', sessionId, `/session/${encodeURIComponent(sessionId)}/unrevert`, {})
        : noSession(),
    async observeTurn({ messageId, sessionId }) {
      const identity = resolveTurnObservationIdentity(sessionId, messageId, pinnedSessionId())
      const readStart = performance.now()
      const turn = await observeRequestedTurn(opencode.getInternalUrl(), workspace(), identity)
      return {
        body: {
          message_id: messageId,
          opencode_session_id: identity.sessionId,
          in_flight: turn.inFlight,
          end: turn.end,
          orphaned_prompt: turn.orphanedPrompt ?? false,
          seq: kortixEventBus().headSeq,
        },
        readMs: performance.now() - readStart,
      }
    },
    events: {
      get epoch() {
        return kortixEventBus().epoch
      },
      get headSeq() {
        return kortixEventBus().headSeq
      },
      get firstSeq() {
        return kortixEventBus().firstSeq
      },
      subscribe: (listener, options) =>
        kortixEventBus().subscribe(listener, { ...options, recover: OPENCODE_EVENT_RECOVERY }),
    },
    attachments: createOpenCodeAttachmentService(opencode, {
      sidecarDir: sidecarDir === undefined ? defaultSidecarDir(OPENCODE_HOME) : sidecarDir,
    }),
  }
}

async function readMessagesOverHttp(
  opencode: Opencode,
  workspace: string,
  sessionId: string,
  options: { limit: number; before: string | null },
): Promise<
  | { ok: true; messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> }
  | { ok: false; detail: string }
> {
  const params = new URLSearchParams({ directory: workspace, limit: String(options.limit) })
  if (options.before) params.set('before', options.before)
  const url = `${opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/message?${params.toString()}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return { ok: false, detail: `opencode ${res.status}` }
    const body = (await res.json()) as unknown
    if (!Array.isArray(body)) return { ok: false, detail: 'unexpected message list shape' }
    const messages = body
      .filter((entry): entry is { info: Record<string, unknown>; parts?: unknown } =>
        Boolean(entry && typeof entry === 'object' && (entry as { info?: unknown }).info),
      )
      .map((entry) => ({
        info: entry.info,
        parts: Array.isArray(entry.parts) ? (entry.parts as Array<Record<string, unknown>>) : [],
      }))
    return { ok: true, messages }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export function findAttachment(
  parts: Array<Record<string, unknown>> | undefined,
  partID: string,
): AttachmentLike | null {
  for (const part of parts ?? []) {
    if (!part || typeof part !== 'object') continue
    for (const a of inlineAttachmentsOf(part)) {
      if (a.id === partID) return a
    }
  }
  return null
}

/** Attachment lookup understands native rows and the native offload sidecar. */
export function createOpenCodeAttachmentService(
  opencode: Opencode,
  opts: { sidecarDir: string | null } = { sidecarDir: null },
): HarnessAttachmentService {
  return {
    async read({ sessionId: sessionID, messageId: messageID, partId: partID }) {
      const workspace = process.env.KORTIX_WORKSPACE || '/workspace'
      const url =
        `${opencode.getInternalUrl()}/session/${encodeURIComponent(sessionID)}` +
        `/message/${encodeURIComponent(messageID)}?directory=${encodeURIComponent(workspace)}`
      let message: { parts?: Array<Record<string, unknown>> }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) {
          return {
            kind: 'error',
            reason: res.status === 404 ? 'not-found' : 'upstream',
            body: { error: 'message not found', status: res.status },
          }
        }
        message = (await res.json()) as typeof message
      } catch (err) {
        logger.error('[part] upstream read failed', err)
        return { kind: 'error', reason: 'upstream', body: { error: 'upstream unreachable' } }
      }
      const part = findAttachment(message.parts, partID)
      if (!part || typeof part.url !== 'string') {
        return { kind: 'error', reason: 'not-found', body: { error: 'part not found' } }
      }
      // Offloaded (attachment-offload.ts): the marker when the row came straight
      // from the daemon, the placeholder URL when it came through OpenCode (which
      // drops unknown fields). The sidecar path is deterministic from the id.
      const sidecar = part.kortix?.offloaded
        ? part.kortix.sidecar
        : isOffloadPlaceholder(part.url) && opts.sidecarDir
          ? sidecarPathFor(opts.sidecarDir, partID)
          : null
      if (sidecar && (part.kortix?.offloaded || existsSync(sidecar))) {
        try {
          const bytes = readFileSync(sidecar)
          return { kind: 'bytes', bytes, mime: part.kortix?.mime || part.mime || 'application/octet-stream' }
        } catch (err) {
          logger.error('[part] offloaded sidecar unreadable', { sidecar, err: (err as Error).message })
          return {
            kind: 'error',
            reason: 'missing-bytes',
            body: { error: 'attachment bytes missing', sidecar },
          }
        }
      }
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(part.url)
      if (!match) {
        return { kind: 'redirect', location: part.url }
      }
      const mimeFromUrl = match[1]
      const isBase64 = Boolean(match[2])
      const payload = match[3] ?? ''
      const bytes = isBase64
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8')
      return { kind: 'bytes', bytes, mime: part.mime || mimeFromUrl || 'application/octet-stream' }
    },
  }
}
