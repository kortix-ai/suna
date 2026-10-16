/**
 * A fake apps/api for the session-log boot reconcile (P6.4) on the real harnesses: the manifest,
 * the restore claim, the journal (with the generation fence), the attachment bytes (`log/blobs`, P2.13:
 * stored in `objects` under `blob-<sha256>`; `failBlobPuts` answers that many PUTs 503) and the
 * attachments route, over one stored `SessionLog`. `maxBytes`: a log whose messages' JSON is longer
 * answers the restore 413 `session_log_too_large` (claimed, no message), as the API's cap does. It points the daemon's control-plane env at itself;
 * `stop` puts the env back.
 */
import type { SessionLog, SessionLogJournalRequest, SessionLogMessage, SessionLogManifest, SessionLogRestore, SessionLogRestoreTooLarge } from '@kortix/api-contract/session-log'

const KEYS = ['KORTIX_API_URL', 'KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_RUNTIME_STATE_DIR', 'KORTIX_SESSION_LOG_RESTORE'] as const

export function fakeSessionLogApi(initial: SessionLog, env: { projectId: string; stateDir: string; generation?: number; objects?: Map<string, Buffer>; failBlobPuts?: number; maxBytes?: number }) {
  const stored = structuredClone(initial)
  const objects = env.objects ?? new Map<string, Buffer>()
  let failBlobPuts = env.failBlobPuts ?? 0
  let generation = env.generation ?? 0
  const calls: string[] = []
  const journal: SessionLogJournalRequest[] = []
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  const messages = () => stored.threads.flatMap((t) => t.messages)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      const route = path.split('/').slice(-2).join('/')
      calls.push(`${request.method} ${route}`)
      if (route === 'log/manifest') {
        return Response.json({ generation, messages: messages().map((m) => ({ message_id: m.message_id, content_hash: 'sha256:-', rev: 1, deleted: false })) } satisfies SessionLogManifest)
      }
      if (route === 'log/restore') {
        generation += 1
        const seq_max = Object.fromEntries(stored.threads.map((t) => [t.thread_id, Math.max(0, ...t.messages.map((m) => m.seq))]))
        const bytes = messages().reduce((n, m) => n + JSON.stringify(m).length, 0)
        if (env.maxBytes !== undefined && bytes > env.maxBytes) {
          const log = { ...stored, threads: stored.threads.map((t) => ({ ...t, messages: [] })) }
          const revs = Object.fromEntries(messages().map((m) => [m.message_id, 1]))
          return Response.json({ generation, log, revs, seq_max, blobs: [], error: 'session_log_too_large', bytes, limit: env.maxBytes, messages: messages().length } satisfies SessionLogRestoreTooLarge, { status: 413 })
        }
        return Response.json({ generation, log: stored, revs: {}, seq_max, blobs: [] } satisfies SessionLogRestore)
      }
      if (path.includes('/log/blobs/')) {
        const sha256 = path.split('/').at(-1)!
        const ref = `kortix-attachment://${env.projectId}/${initial.session_id}/blob-${sha256}`
        if (request.method === 'GET') return Response.json({ ref: objects.has(`blob-${sha256}`) ? ref : null })
        if (failBlobPuts > 0 && failBlobPuts--) return new Response('unavailable', { status: 503 })
        const bytes = Buffer.from(await request.arrayBuffer())
        if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== sha256) return new Response('sha256 mismatch', { status: 400 })
        objects.set(`blob-${sha256}`, bytes)
        return Response.json({ ref })
      }
      if (path.includes('/attachments/')) {
        const bytes = objects.get(path.split('/').at(-1)!)
        return bytes ? new Response(new Uint8Array(bytes)) : new Response('not found', { status: 404 })
      }
      if (route === 'log/journal') {
        const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await request.arrayBuffer())))) as SessionLogJournalRequest
        journal.push(body)
        if (body.generation < generation) return Response.json({ generation }, { status: 409 })
        for (const { message } of body.puts as Array<{ message: SessionLogMessage }>) {
          let thread = stored.threads.find((t) => t.thread_id === message.thread_id)
          if (!thread) stored.threads.push((thread = { ...body.threads.find((t) => t.thread_id === message.thread_id)!, messages: [] }))
          thread.messages = [...thread.messages.filter((m) => m.message_id !== message.message_id), message].sort((a, b) => a.seq - b.seq)
        }
        for (const { message_id } of body.tombstones) for (const t of stored.threads) t.messages = t.messages.filter((m) => m.message_id !== message_id)
        if (body.session) Object.assign(stored, body.session)
        return Response.json({ acked: [...body.puts.map((p) => ({ message_id: p.message.message_id, rev: p.rev })), ...body.tombstones] })
      }
      return new Response('not found', { status: 404 })
    },
  })
  Object.assign(process.env, {
    KORTIX_API_URL: `http://127.0.0.1:${server.port}`,
    KORTIX_PROJECT_ID: env.projectId,
    KORTIX_SESSION_ID: initial.session_id,
    KORTIX_TOKEN: 'dummy-session-token',
    KORTIX_RUNTIME_STATE_DIR: env.stateDir,
    KORTIX_SESSION_LOG_RESTORE: '1',
  })
  return {
    calls,
    journal,
    stored: () => stored,
    objects,
    generation: () => generation,
    stop() {
      server.stop(true)
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    },
  }
}
