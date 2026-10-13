/**
 * The restore answer (P6.1, `POST /v1/projects/:p/sessions/:s/log/restore`) as the
 * `SessionLog` a harness adapter's `restore` writes (P6.2). The answer's records hold a
 * 16 kB preview of each text over 256 kB (F3); `blobs` lists the ones the API stored.
 * Each listed text is read in full through
 * `GET /v1/projects/:p/sessions/:s/attachments/<last segment of ref>` with the sandbox
 * credential and checked against its `sha256`, then put back in place of the preview
 * (`ref` and `bytes` removed).
 *
 * A text that keeps its preview stays `ref` + `bytes` and is reported in `truncated`:
 * - `not_listed`: the record has a `ref` the answer does not list (a ref the daemon sent
 *   itself, or an object the API lost);
 * - `unreadable`: the read failed after the retries, or the ref names another session's
 *   folder (the box reads only its own);
 * - `sha256_mismatch`: the body is not the stored text.
 * The boot decides what a truncated text means for the session (P6.4).
 */
import { createHash } from 'node:crypto'
import type { SessionLog, SessionLogRestore } from '@kortix/api-contract/session-log'
import type { SandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { logger } from '@/lib/log/logger'

export type TruncatedText = { message_id: string; block_id: string; ref: string; reason: 'not_listed' | 'unreadable' | 'sha256_mismatch' }
export type RestoredSessionLog = { generation: number; log: SessionLog; revs: Record<string, number>; truncated: TruncatedText[] }

type Text = { type: 'text'; text: string; ref?: string; bytes?: number }
type Block = { type: string; id: string; result?: { content?: unknown[]; model_content?: unknown[] } }

/** The F3 texts of one block: the text block, or its tool result's text items (the API's `referencedTexts`). */
const textsOf = (b: Block): Text[] =>
  (b.type === 'text' ? [b] : b.type === 'tool_call' ? [...(b.result?.content ?? []), ...(b.result?.model_content ?? [])] : []).filter(
    (t): t is Text => (t as Text)?.type === 'text' && typeof (t as Text).text === 'string',
  )

export async function sessionLogFromRestore(answer: SessionLogRestore, readText: (ref: string) => Promise<string | null>): Promise<RestoredSessionLog> {
  const log = structuredClone(answer.log) as SessionLog
  const listed = new Map(answer.blobs.map((b) => [`${b.message_id}\0${b.ref}`, b]))
  const truncated: TruncatedText[] = []
  for (const message of log.threads.flatMap((t) => t.messages)) {
    for (const block of message.blocks as Block[]) {
      for (const t of textsOf(block)) {
        if (t.ref === undefined) continue
        const blob = listed.get(`${message.message_id}\0${t.ref}`)
        const full = blob ? await readText(t.ref) : null
        const reason = !blob ? 'not_listed' : full === null ? 'unreadable' : createHash('sha256').update(full).digest('hex') !== blob.sha256 ? 'sha256_mismatch' : null
        if (reason) {
          truncated.push({ message_id: message.message_id, block_id: block.id, ref: t.ref, reason })
          continue
        }
        t.text = full!
        delete t.ref
        delete t.bytes
      }
    }
  }
  if (truncated.length) logger.warn('[session-log] restore keeps a preview for texts it could not read', { count: truncated.length, reasons: [...new Set(truncated.map((t) => t.reason))] })
  return { generation: answer.generation, log, revs: answer.revs, truncated }
}

const READ_ATTEMPTS = 3

/** Reads a stored text of this session through the attachments route; null when it is missing, foreign or unreadable after 3 attempts. */
export function apiTextReader(ctx: SandboxRelayContext, retryMs = 200): (ref: string) => Promise<string | null> {
  const own = `kortix-attachment://${ctx.projectId}/${ctx.sessionId}/`
  return async (ref) => {
    if (!ref.startsWith(own) || ref.slice(own.length).includes('/')) return null
    const url = `${ctx.apiRoot}/projects/${ctx.projectId}/sessions/${ctx.sessionId}/attachments/${ref.slice(own.length)}`
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}` } })
        if (response.ok) return await response.text()
        // A 4xx other than 408/429 does not change on a retry.
        if (response.status < 500 && response.status !== 408 && response.status !== 429) return null
      } catch {
        // Network error: retried.
      }
      if (attempt === READ_ATTEMPTS) return null
      await Bun.sleep(retryMs * attempt)
    }
  }
}
