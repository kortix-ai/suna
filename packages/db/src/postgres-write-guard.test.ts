/**
 * Regression test for KRTX-2511: postgres.js 3.4.9 kills the process with an
 * uncaught `TypeError: null is not an object (evaluating 'socket.write')` in
 * `nextWrite` (src/connection.js:255) after a connection closes mid-write.
 *
 * Crash sequence (porsager/postgres#1066, #1154, #1208; same stack as the prod
 * error in Better Stack, app "Kortix API (prod)"):
 *   1. `sql.reserve()` takes the pool's only connection.
 *   2. A query on the reserved connection stays in flight; the server closes the
 *      socket -> the query rejects with CONNECTION_CLOSED and connection.js
 *      `closed()` sets `socket = null`.
 *   3. `release()` puts the dead connection back into the open queue
 *      (upstream pool bug: onclose already nulled `c.reserved`).
 *   4. `reserve()` hands the same dead connection out again; the next small
 *      (<1024 B) query schedules `setImmediate(nextWrite)` and the immediate
 *      dereferences the nulled socket -> uncaught TypeError -> process death.
 *
 * The fix is a pnpm patch on postgres@3.4.9 (`patches/postgres@3.4.9.patch`)
 * mirroring the unreleased upstream guard (PRs #1168/#1176): `nextWrite` returns
 * false and drops the buffered chunk when the socket is gone.
 *
 * The test drives postgres.js over a real TCP socket against an in-process fake
 * PostgreSQL server (minimal startup handshake + extended-protocol replies), so
 * it needs no database and reproduces the event ordering deterministically.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import net from 'node:net'
import postgres from 'postgres'

/** One Postgres wire-protocol message: 1-byte type + 4-byte length + payload. */
function msg(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head[0] = type.charCodeAt(0)
  head.writeUInt32BE(payload.length + 4, 1) // length excludes the type byte
  return Buffer.concat([head, payload])
}
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b }
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b }
const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
const parseReply = () => Buffer.concat([
  msg('t', i16(0)), // ParameterDescription (none)
  msg('T', i16(0)), // RowDescription (no columns)
  msg('1', Buffer.alloc(0)), // ParseComplete
])
const noData = () => msg('n', Buffer.alloc(0))
const bindComplete = () => msg('2', Buffer.alloc(0))
const dataRow0 = () => msg('D', i16(0))
const cmdComplete = () => msg('C', cstr('SELECT 0'))
const readyForQuery = () => msg('Z', Buffer.from([0x49])) // 'I' idle

describe('postgres 3.4.9 nextWrite survives a connection that closes mid-write', () => {
  let uncaught: Error[] = []
  let onUncaught: ((e: Error) => void) | null = null

  beforeAll(() => {
    onUncaught = (e) => uncaught.push(e)
    process.on('uncaughtException', onUncaught)
  })

  afterAll(() => {
    if (onUncaught) process.off('uncaughtException', onUncaught)
  })

  test('a write queued after the socket died does not throw an uncaught TypeError', async () => {
    uncaught = []
    const sock = { client: null as net.Socket | null }
    let connections = 0
    let sawQuery = false

    // Minimal fake PostgreSQL: startup handshake, then extended-protocol
    // replies. The first real query gets NO reply (stays in flight) so the
    // repro can close the socket while the connection has work outstanding.
    const server = net.createServer((socket) => {
      connections++
      sock.client = socket
      let buf = Buffer.alloc(0)
      let startupDone = false
      let hung = false
      socket.on('data', (x) => {
        buf = Buffer.concat([buf, x])
        for (;;) {
          if (!startupDone) {
            if (buf.length < 4) return
            const len = buf.readUInt32BE(0)
            if (buf.length < len) return
            buf = buf.subarray(len)
            startupDone = true
            socket.write(Buffer.concat([
              msg('R', i32(0)), // AuthenticationOk
              msg('K', Buffer.concat([i32(1), i32(2)])), // BackendKeyData
              readyForQuery(),
            ]))
            continue
          }
          if (buf.length < 5) return
          const len = buf.readUInt32BE(1)
          if (buf.length < len + 1) return
          const type = String.fromCharCode(buf[0])
          const body = buf.subarray(5, len + 1)
          buf = buf.subarray(len + 1)
          const text = body.toString('utf8').replace(/\0/g, ' ')
          if (text.includes('pg_type')) { // handshake types query: always answer
            if (type === 'P' || type === 'D') socket.write(parseReply())
            else if (type === 'B') socket.write(bindComplete())
            else if (type === 'E') socket.write(Buffer.concat([dataRow0(), cmdComplete()]))
            else if (type === 'S') socket.write(readyForQuery())
            continue
          }
          switch (type) {
            case 'P':
              sawQuery = true
              if (!hung) {
                hung = true // the first real query hangs: no reply at all
                continue
              }
              socket.write(parseReply())
              continue
            case 'D':
              socket.write(noData())
              continue
            case 'B':
              if (!hung) socket.write(bindComplete())
              continue
            case 'E':
              if (!hung) socket.write(Buffer.concat([dataRow0(), cmdComplete()]))
              continue
            case 'S':
              if (!hung) socket.write(readyForQuery())
              continue
            case 'X':
              socket.end()
              return
          }
        }
      })
      socket.on('error', () => { /* the repro closes this socket on purpose */ })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port

    const sql = postgres({
      host: '127.0.0.1',
      port,
      database: 'kortix',
      username: 'postgres',
      password: 'postgres',
      max: 1,
      connect_timeout: 5,
    })

    try {
      // 1. reserve the pool's only connection (cold pool: handshake happens now)
      const r1 = await sql.reserve()
      expect(connections).toBe(1)

      // 2. start a query the server never answers
      const q1State = { code: null as string | null }
      const q1 = r1`select pg_sleep(60) as x`.then(
        () => ((q1State.code = 'resolved'), null),
        (e: { code?: string }) => ((q1State.code = e.code ?? 'rejected'), Promise.reject(e)),
      )
      for (let i = 0; i < 200 && !sawQuery; i++) await new Promise((r) => setTimeout(r, 10))
      expect(sawQuery).toBe(true) // the server received it (the repro is on the wire)
      await new Promise((r) => setTimeout(r, 20)) // let the client's write immediate settle

      // 3. server kills the socket mid-query -> CONNECTION_CLOSED, socket = null
      sock.client?.destroy()
      await q1.catch(() => {})
      expect(q1State.code).toBe('CONNECTION_CLOSED')

      // 4. release -> the dead connection goes back into the open queue
      r1.release()
      await new Promise((r) => setTimeout(r, 10))

      // 5. reserve again -> the pool hands out the SAME dead connection
      const r2 = await sql.reserve()
      expect(connections).toBe(1) // no new handshake: the dead one was reused

      // 6. a small (<1024 B) query queues setImmediate(nextWrite); without the
      // patch the immediate dereferences the nulled socket and the process dies.
      const q2State = { settled: null as string | null }
      r2`select 1 as y`.then(
        () => ((q2State.settled = 'resolved'), null),
        (e: { code?: string; message?: string }) =>
          ((q2State.settled = 'rejected: ' + (e.code ?? e.message)), null),
      )
      for (let i = 0; i < 50 && (uncaught.length === 0 || q2State.settled === null); i++) {
        await new Promise((r) => setTimeout(r, 20))
      }

      expect(uncaught).toEqual([]) // <- the actual regression: this used to hold the TypeError
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {})
      server.close()
    }
  }, 30_000)
})
