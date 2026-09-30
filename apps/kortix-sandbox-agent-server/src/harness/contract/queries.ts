import type { Config } from '@/lib/config/config'
import type { KortixEventListener, SubscribeResult } from '@/services/event-bus/kortix-event-bus'

/** Existing response documents remain opaque until the public protocol changes. */
export type HarnessDocument = Record<string, unknown>

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
