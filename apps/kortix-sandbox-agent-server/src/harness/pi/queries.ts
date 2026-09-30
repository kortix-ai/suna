/**
 * The `/kortix/opencode/*` namespace for a pi session: state, transcript pages,
 * the sequenced event stream and attachment bytes. Same shapes as the OpenCode
 * adapter serves — the web client is not namespace-parameterized.
 */
import { kortixEventBus } from '@/services/event-bus/kortix-event-bus'
import { stripInlineAttachmentBytes } from '../shared/inline-attachments'
import type { HarnessAttachmentService, HarnessQueryFactory, HarnessQueryService } from '../contract/queries'
import type { PiRuntime } from './runtime'

export const PI_EVENT_RECOVERY = ['GET /kortix/runtime/state', 'GET /kortix/runtime/messages/:sessionId?limit=20'] as const

const TOOL_OUTPUT_MAX_BYTES = 64 * 1024

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) return null
  return { mime: match[1]!, bytes: new Uint8Array(Buffer.from(match[2]!, 'base64')) }
}

export function createPiQueryService(runtime: () => PiRuntime | null): HarnessQueryFactory {
  const attachments: HarnessAttachmentService = {
    async read({ messageId, partId }) {
      const rt = runtime()
      const message = rt?.transcript.messageById(messageId)
      const part = message?.parts.find((candidate) => candidate.id === partId)
      if (!rt || !part || part.type !== 'file') return { kind: 'error', reason: 'not-found', body: { error: 'attachment not found' } }
      const decoded = decodeDataUrl(part.url)
      if (!decoded) return { kind: 'error', reason: 'missing-bytes', body: { error: 'attachment bytes are not held by this box' } }
      return { kind: 'bytes', bytes: decoded.bytes, mime: part.mime || decoded.mime }
    },
  }

  return {
    bind(): HarnessQueryService {
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
              ? { messages: transcript.all().filter((m) => m.info.id > after).slice(0, limit), hasMore: false }
              : transcript.page({ limit, before })
            : { messages: [], hasMore: false }
          let truncated = 0
          const projected = page.messages.map((message) => ({
            info: message.info,
            parts: message.parts.map((part) => {
              const state = part.type === 'tool' ? part.state : undefined
              if (state?.status === 'completed' && state.output.length > TOOL_OUTPUT_MAX_BYTES) {
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
