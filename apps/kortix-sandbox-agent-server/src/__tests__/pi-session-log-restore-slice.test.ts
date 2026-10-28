/**
 * The pi writer on an over-cap restore (`kept: 'model_view'`): each thread arrives cut to
 * `modelViewSliceIds`, so its oldest messages are absent. What pi sends the model next is pi-ai's
 * `transformMessages` of `buildSessionProjection` of the store it loads (for the root the dump's
 * entries, for a sub-agent its `agentMessages`). For every fixture shape (pi's native summary + tail,
 * OpenCode's compaction pair, a `layout` compaction, no compaction) the store written from the cut
 * log sends exactly what the store written from the whole log sends. The projections differ in one
 * way only: the whole log's out-of-context failed replies, which pi writes with their error
 * `stopReason` and pi-ai never sends. No runtime starts: the dump is the contract.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionProjection, type SessionEntry } from '@earendil-works/pi-coding-agent'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { modelViewSliceIds, type SessionLog } from '@kortix/api-contract/session-log'
import { restorePiSessionLog } from '@/harness/pi/session-log-restore'
import { piDumpPath, type PiDump } from '@/harness/pi/runtime'

const FIXTURES = join(import.meta.dir, '../../../../packages/api-contract/src/__tests__/fixtures/session-log')
const NAMES = ['golden', 'golden21', 'pi', 'opencode', 'opencode-v2', 'claude-code', 'codex'] as const
/** The fixtures' one image (`blob:<sha256>`): a synthetic 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const blobs = new Map([[`blob:${createHash('sha256').update(PNG).digest('hex')}`, PNG]])

/** A model no fixture used: pi-ai lowers every thinking block the same way on both sides. */
const MODEL = { id: 'test-model', name: 'Test Model', api: 'openai-completions', provider: 'test', baseUrl: 'http://127.0.0.1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 4_096 } as const
type Messages = Parameters<typeof transformMessages>[0]
/** The messages pi-ai sends for a projected context, and the failed replies it skips. */
const sent = (messages: unknown[]) => transformMessages(messages as Messages, MODEL as never)
const failed = (messages: unknown[]) => (messages as Array<{ role: string; stopReason?: string }>).filter((m) => m.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted'))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const cut = (log: SessionLog): SessionLog => ({
  ...log,
  threads: log.threads.map((t) => {
    const keep = modelViewSliceIds(t.messages)
    return { ...t, messages: t.messages.filter((m) => keep.has(m.message_id)) }
  }),
})

/** Restores `log` into a fresh pi state dir; answers what pi projects for the root and each sub-agent, and what the writer dropped. */
async function written(log: SessionLog, seqMax: Record<string, number>) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pi-restore-slice-'))
  dirs.push(stateDir)
  const { dropped } = await restorePiSessionLog(log, { stateDir, sessionId: log.session_id, cwd: stateDir, readAttachment: async (ref) => blobs.get(ref) ?? null }, seqMax)
  const dump = JSON.parse(readFileSync(piDumpPath(stateDir, log.session_id), 'utf8')) as PiDump
  return {
    root: buildSessionProjection(dump.entries as SessionEntry[]).messages,
    children: Object.fromEntries((dump.children ?? []).map((c) => [c.id, c.agentMessages])),
    // The id pi's rebuilt system prompt takes: the journal replaces that context record instead of adding one per restore.
    contextIds: [dump.contextId, ...(dump.children ?? []).map((c) => c.contextId)],
    dropped,
  }
}

const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.v2.json`), 'utf8')) as SessionLog
/** The pi fixture with its cut point (seq 5) out of context: the slice keeps it only so pi can resolve `firstKeptEntryId`. */
const hiddenCut = (): SessionLog => {
  const log = fixture('pi')
  const marker = log.threads[0]!.messages.find((m) => m.kind === 'compaction')!
  const cutId = (marker.blocks[0] as { first_kept_message_id: string }).first_kept_message_id
  log.threads[0]!.messages.find((m) => m.message_id === cutId)!.in_context = false
  return log
}
const CASES: Array<[string, () => SessionLog]> = [...NAMES.map((n): [string, () => SessionLog] => [n, () => fixture(n)]), ['pi with its cut point out of context', hiddenCut]]

describe('pi writes a model_view slice as it writes the whole log', () => {
  for (const [name, load] of CASES) {
    test(`${name}: what pi sends for every thread is what it sends after a whole-log restore, and the slice left messages out`, async () => {
      const log = load()
      const seqMax = Object.fromEntries(log.threads.map((t) => [t.thread_id, Math.max(0, ...t.messages.map((m) => m.seq))]))
      const sliced = cut(log)
      const whole = await written(log, seqMax)
      const part = await written(sliced, seqMax)
      expect(sent(part.root)).toEqual(sent(whole.root))
      for (const [id, messages] of Object.entries(whole.children)) expect(sent(part.children[id]!)).toEqual(sent(messages))
      expect(Object.keys(part.children)).toEqual(Object.keys(whole.children))
      expect(part.dropped).toEqual(whole.dropped)
      expect(part.contextIds).toEqual(whole.contextIds)
      // The raw projection: the same messages, but for the failed replies pi-ai skips.
      const ok = (messages: unknown[]) => messages.filter((m) => !failed([m]).length)
      expect(ok(part.root)).toEqual(ok(whole.root))
      expect(failed(part.root)).toEqual([])
      expect(sliced.threads.flatMap((t) => t.messages).length).toBeLessThan(log.threads.flatMap((t) => t.messages).length)
    })
  }
})
