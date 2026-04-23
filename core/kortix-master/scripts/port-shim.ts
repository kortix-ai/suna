import { connect } from 'node:net'

const LISTEN_PORT = Number(process.env.KORTIX_PORT_SHIM_LISTEN || 3456)
const TARGET_HOST = process.env.KORTIX_PORT_SHIM_TARGET_HOST || '127.0.0.1'
const TARGET_PORT = Number(process.env.KORTIX_PORT_SHIM_TARGET_PORT || 8000)

console.log(`[port-shim] TCP ${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`)

Bun.listen({
  hostname: '0.0.0.0',
  port: LISTEN_PORT,
  socket: {
    open(client) {
      const upstream = connect(TARGET_PORT, TARGET_HOST)
      let upstreamReady = false
      const pending: Buffer[] = []

      upstream.on('connect', () => {
        upstreamReady = true
        for (const chunk of pending) upstream.write(chunk)
        pending.length = 0
      })
      upstream.on('data', (chunk: Buffer) => {
        try { client.write(chunk) } catch {}
      })
      upstream.on('end', () => {
        try { client.end() } catch {}
      })
      upstream.on('error', (err: Error) => {
        console.error(`[port-shim] upstream error: ${err.message}`)
        try { client.end() } catch {}
      })

      ;(client as any).__upstream = upstream
      ;(client as any).__pending = pending
      ;(client as any).__ready = () => upstreamReady
    },
    data(client, chunk) {
      const upstream = (client as any).__upstream
      const pending = (client as any).__pending as Buffer[] | undefined
      const ready = (client as any).__ready as (() => boolean) | undefined
      if (!upstream) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (ready && ready()) {
        try { upstream.write(buf) } catch {}
      } else if (pending) {
        pending.push(buf)
      }
    },
    close(client) {
      const upstream = (client as any).__upstream
      if (upstream) { try { upstream.end() } catch {} }
    },
    error(client, err) {
      console.error(`[port-shim] client error: ${err?.message || err}`)
      const upstream = (client as any).__upstream
      if (upstream) { try { upstream.destroy() } catch {} }
    },
  },
})
