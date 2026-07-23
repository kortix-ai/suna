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

/**
 * Fixed listeners on the standard sandbox image that are never "the user's
 * app" — infra plumbing (the sandbox provider's own runner/toolbox agent,
 * SSH gateways, internal proxies) that happens to be visible in the same
 * `/proc/net/tcp{,6}` scan `/ports` uses to find real app servers. Surfacing
 * these in the Preview card would show junk alongside (or ahead of) the app
 * the agent actually started (Jay's live session `cbfba498-…`).
 *
 * Excluded unconditionally, independent of whatever cfg-specific ports a
 * caller passes via `excludedPorts` (servicePort/opencodeInternalPort/
 * staticPort — see proxy.ts) — a caller forgetting to pass one of these must
 * never leak it back into the Preview card.
 *
 * Owners were identified by grepping this repo end to end: Dockerfile layers
 * under apps/api/src/snapshots + apps/sandbox, this package's own
 * config/pty/static routes, packages/shared sandbox constants, and the
 * vendored @daytonaio/sdk client. None of the four numbers below appear
 * anywhere in that search — they are not started by anything in this repo's
 * build, so they must come from the sandbox provider's own runtime injected
 * into the VM/container outside this repo (Daytona's runner/toolbox agent is
 * the leading suspect, but that process isn't visible from the client SDK
 * package, so it can't be confirmed from here). Labeled honestly rather than
 * guessed at.
 */
export const INFRA_PORTS: ReadonlySet<number> = new Set([
  2280, // observed on the standard image; owner unidentified
  22220, // observed on the standard image; owner unidentified
  22222, // observed on the standard image; owner unidentified
  33333, // observed on the standard image; owner unidentified
])

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
        if (port < 1024 || INFRA_PORTS.has(port) || opts.excludedPorts.has(port)) continue
        seen.add(port)
      }
    }
    const ports = [...seen].sort((a, b) => a - b).map((port) => ({ port }))
    return c.json({ ports })
  })
  return app
}
