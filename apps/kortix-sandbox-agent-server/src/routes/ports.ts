import { Hono } from 'hono'
import fs from 'node:fs/promises'

/** Listening TCP ports inside the sandbox — /proc/net/tcp{,6} `st 0A` rows.
 * One file read per request; no exec, no scanning; [] off-Linux. */
export function parseProcNetTcp(text: string): number[] {
  const ports: number[] = []
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4 || cols[3] !== '0A') continue
    const hex = cols[1]?.split(':').pop()
    if (!hex) continue
    const port = Number.parseInt(hex, 16)
    if (Number.isFinite(port) && port > 0) ports.push(port)
  }
  return ports
}

export function createPortsRouter(opts: {
  excludedPorts: ReadonlySet<number>
  readProcFile?: (path: string) => Promise<string>
}): Hono {
  const read = opts.readProcFile ?? ((p: string) => fs.readFile(p, 'utf8'))
  const app = new Hono()
  app.get('/', async (c) => {
    const texts = await Promise.all(
      ['/proc/net/tcp', '/proc/net/tcp6'].map((p) => read(p).catch(() => '')),
    )
    const seen = new Set<number>()
    for (const text of texts) {
      for (const port of parseProcNetTcp(text)) {
        if (port < 1024 || opts.excludedPorts.has(port)) continue
        seen.add(port)
      }
    }
    const ports = [...seen].sort((a, b) => a - b).map((port) => ({ port }))
    return c.json({ ports })
  })
  return app
}
