import type { Config } from '../config'
import type { KortixEventListener, SubscribeResult } from '../kortix-event-bus'

/** Existing response documents remain opaque until the public protocol changes. */
export type HarnessDocument = Record<string, unknown>

export type HarnessReadResult =
  | { ok: true; upstreamStatus: number; contentType: string; text: string }
  | { ok: false; body: HarnessDocument }

export type HarnessActionResult =
  | { ok: true; body: HarnessDocument }
  | { ok: false; reason: 'no-session' | 'not-found' | 'upstream'; body: HarnessDocument }

export type HarnessAttachmentResult =
  | { kind: 'bytes'; bytes: Uint8Array; mime: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'error'; reason: 'not-found' | 'upstream' | 'missing-bytes'; body: HarnessDocument }

export interface HarnessAttachmentService {
  read(input: { sessionId: string; messageId: string; partId: string }): Promise<HarnessAttachmentResult>
}

export interface HarnessQueryService {
  readState(): Promise<{ doc: unknown; etag: string; readMs: number }>
  readMessages(input: {
    sessionId: string
    limit: number
    before: string | null
    after: string | null
    afterSeq: number | null
  }): Promise<
    { ok: true; body: HarnessDocument; source: string; readMs: number } | { ok: false; body: HarnessDocument }
  >
  readVcsDiff(mode?: string): Promise<HarnessReadResult>
  readCurrentProject(): Promise<HarnessReadResult>
  readConfiguration(): Promise<HarnessReadResult>
  readSession(sessionId: string): Promise<HarnessReadResult>
  readTodo(sessionId: string): Promise<HarnessReadResult>
  pinnedSessionId(): string | null
  replyPermission(input: {
    id: string
    reply: 'once' | 'always' | 'reject'
    message?: string
    sessionId: string | null
  }): Promise<HarnessActionResult>
  replyQuestion(input: {
    id: string
    answers: unknown[]
    sessionId: string | null
  }): Promise<HarnessActionResult>
  rejectQuestion(input: { id: string; sessionId: string | null }): Promise<HarnessActionResult>
  stopSession(sessionId: string | null): Promise<HarnessActionResult>
  revertSession(input: {
    sessionId: string | null
    messageId: string
    partId?: string
  }): Promise<HarnessActionResult>
  unrevertSession(sessionId: string | null): Promise<HarnessActionResult>
  observeTurn(input: {
    messageId: string
    sessionId?: string
  }): Promise<{ body: HarnessDocument; readMs: number }>
  readonly events: {
    readonly epoch: string
    readonly headSeq: number
    readonly firstSeq: number
    subscribe(
      listener: KortixEventListener,
      options: { since: number | null; epoch: string | null },
    ): SubscribeResult
  }
  readonly attachments: HarnessAttachmentService
}

/** Rebind configuration on proxy rebuild without replacing maintained state. */
export interface HarnessQueryFactory {
  bind(context: { cfg: Config }): HarnessQueryService
}
