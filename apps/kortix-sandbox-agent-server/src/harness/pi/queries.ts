/**
 * The `/kortix/opencode/*` namespace for a pi session: state, transcript pages,
 * the sequenced event stream, actions and attachment bytes. Same shapes as the
 * OpenCode adapter serves — the web client is not namespace-parameterized.
 */
import { kortixEventBus } from '../../kortix-event-bus'
import { stripInlineAttachmentBytes } from '../../inline-attachments'
import type {
  HarnessActionResult,
  HarnessAttachmentService,
  HarnessQueryFactory,
  HarnessQueryService,
  HarnessReadResult,
} from '../queries'
import type { PiRuntime } from './runtime'
import type { PiSurface } from './surface'

export const PI_EVENT_RECOVERY = ['GET /kortix/opencode/state', 'GET /kortix/opencode/messages/:sessionId?limit=20'] as const

const TOOL_OUTPUT_MAX_BYTES = 64 * 1024

/** Read one raw-surface route into the namespaced read shape. */
async function readThrough(surface: PiSurface, path: string, search = ''): Promise<HarnessReadResult> {
  const result = await surface.handle({ method: 'GET', path, search, headers: new Headers() })
  const text = typeof result.body === 'string' ? result.body : result.body ? await new Response(result.body).text() : ''
  return { ok: true, upstreamStatus: result.status, contentType: result.headers.get('content-type') ?? 'application/json', text }
}

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) return null
  return { mime: match[1]!, bytes: new Uint8Array(Buffer.from(match[2]!, 'base64')) }
}

export function createPiQueryService(runtime: () => PiRuntime | null, surface: PiSurface): HarnessQueryFactory {
  const attachments: HarnessAttachmentService = {
    async read({ messageId, partId }) {
      const rt = runtime()
      const message = rt?.transcript.messageById(messageId)
      const part = message?.parts.find((candidate) => candidate.id === partId)
      if (!rt || !part) return { kind: 'error', reason: 'not-found', body: { error: 'attachment not found' } }
      const decoded = typeof part.url === 'string' ? decodeDataUrl(part.url) : null
      if (!decoded) return { kind: 'error', reason: 'missing-bytes', body: { error: 'attachment bytes are not held by this box' } }
      return { kind: 'bytes', bytes: decoded.bytes, mime: (part.mime as string | undefined) ?? decoded.mime }
    },
  }

  return {
    bind(): HarnessQueryService {
      const notReady = (): HarnessActionResult => ({ ok: false, reason: 'no-session', body: { ok: false, error: 'pi runtime is not started' } })
      return {
        async readState() {
          const rt = runtime()
          const t0 = performance.now()
          if (!rt) {
            const doc = { epoch: kortixEventBus().epoch, seq: kortixEventBus().headSeq, built_at: new Date().toISOString(), identity: { opencode_session_id: null, harness: 'pi' } }
            return { doc, etag: '"pi-down"', readMs: performance.now() - t0 }
          }
          const doc = rt.stateDoc()
          return { doc, etag: rt.stateEtag(doc), readMs: performance.now() - t0 }
        },
        async readMessages({ sessionId, limit, before, after }) {
          const rt = runtime()
          const t0 = performance.now()
          if (!rt) return { ok: false, body: { error: 'pi runtime is not started' } }
          const transcript = sessionId === rt.rootId ? rt.transcript : rt.childSession(sessionId)?.transcript
          const page = transcript
            ? after
              ? { messages: transcript.all().filter((m) => (m.info.id as string) > after).slice(0, limit), hasMore: false }
              : transcript.page({ limit, before })
            : { messages: [], hasMore: false }
          let truncated = 0
          const projected = page.messages.map((message) => ({
            info: message.info,
            parts: message.parts.map((part) => {
              const state = part.state as Record<string, unknown> | undefined
              if (state && typeof state.output === 'string' && state.output.length > TOOL_OUTPUT_MAX_BYTES) {
                truncated++
                return {
                  ...part,
                  state: {
                    ...state,
                    output: `${state.output.slice(0, TOOL_OUTPUT_MAX_BYTES)}\n… [kortix: truncated ${state.output.length - TOOL_OUTPUT_MAX_BYTES} bytes]`,
                    output_truncated: true,
                  },
                }
              }
              return part
            }),
          }))
          const stripped = stripInlineAttachmentBytes(
            projected,
            (messageId, partId) => `/kortix/part/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}`,
          )
          const messages = stripped.value as typeof projected
          const bus = kortixEventBus()
          return {
            ok: true,
            source: 'pi',
            readMs: performance.now() - t0,
            body: {
              session_id: sessionId,
              epoch: bus.epoch,
              seq: bus.headSeq,
              head_seq: null,
              source: 'pi',
              count: messages.length,
              has_more: page.hasMore,
              first_message_id: messages[0]?.info.id ?? null,
              last_message_id: messages[messages.length - 1]?.info.id ?? null,
              dropped: 0,
              attachments_referenced: stripped.stripped,
              attachment_bytes_saved: stripped.savedBytes,
              tool_outputs_truncated: truncated,
              messages,
            },
          }
        },
        readVcsDiff: () => readThrough(surface, '/vcs/diff'),
        readCurrentProject: () => readThrough(surface, '/project/current'),
        readConfiguration: () => readThrough(surface, '/config'),
        readSession: (sessionId) => readThrough(surface, `/session/${encodeURIComponent(sessionId)}`),
        readTodo: (sessionId) => readThrough(surface, `/session/${encodeURIComponent(sessionId)}/todo`),
        pinnedSessionId: () => runtime()?.rootId ?? null,
        async replyPermission({ id, reply }) {
          const rt = runtime()
          if (!rt) return notReady()
          return rt.permissions.reply(id, reply)
            ? { ok: true, body: { ok: true } }
            : { ok: false, reason: 'not-found', body: { ok: false, error: 'permission request not found' } }
        },
        async replyQuestion({ id, answers }) {
          const rt = runtime()
          if (!rt) return notReady()
          return rt.questions.reply(id, answers as string[][])
            ? { ok: true, body: { ok: true } }
            : { ok: false, reason: 'not-found', body: { ok: false, error: 'question request not found' } }
        },
        async rejectQuestion({ id }) {
          const rt = runtime()
          if (!rt) return notReady()
          return rt.questions.reject(id)
            ? { ok: true, body: { ok: true } }
            : { ok: false, reason: 'not-found', body: { ok: false, error: 'question request not found' } }
        },
        async stopSession() {
          const rt = runtime()
          if (!rt) return notReady()
          await rt.abort()
          return { ok: true, body: { ok: true, opencode_session_id: rt.rootId } }
        },
        async revertSession() {
          return { ok: false, reason: 'upstream', body: { ok: false, error: 'session rewind is not supported by the pi harness', code: 'feature_not_supported' } }
        },
        async unrevertSession() {
          return { ok: false, reason: 'upstream', body: { ok: false, error: 'session rewind is not supported by the pi harness', code: 'feature_not_supported' } }
        },
        async observeTurn({ messageId, sessionId }) {
          const rt = runtime()
          const t0 = performance.now()
          const probe = rt && (!sessionId || sessionId === rt.rootId) ? rt.turnProbe(messageId) : null
          return {
            body: {
              message_id: messageId,
              opencode_session_id: rt?.rootId ?? sessionId ?? null,
              in_flight: probe ? probe.inFlight : null,
              end: probe ? probe.end : null,
              orphaned_prompt: probe?.orphanedPrompt ?? false,
              seq: kortixEventBus().headSeq,
            },
            readMs: performance.now() - t0,
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
          subscribe: (listener, options) => kortixEventBus().subscribe(listener, { ...options, recover: PI_EVENT_RECOVERY }),
        },
        attachments,
      }
    },
  }
}
