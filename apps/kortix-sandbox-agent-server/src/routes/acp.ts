import { Hono } from 'hono'

import {
  AcpProtocolError,
  parseJsonRpcEnvelope,
  type AcpConnection,
} from '../acp/connection'
import type { Config } from '../config'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from '../kortix-user-context'
import { logger } from '../logger'

const encoder = new TextEncoder()
const ALLOWED_SESSION_METHODS = new Set([
  'session/load',
  'session/resume',
  'session/prompt',
  'session/cancel',
  'session/set_config_option',
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAcpRouter(
  cfg: Config,
  getConnection: () => AcpConnection | null,
  getCanonicalSessionId: () => string | null,
): Hono {
  const router = new Hono()

  router.use('*', async (c, next) => {
    if (!cfg.sandboxToken) {
      logger.warn('[opencode-acp] rejecting request: KORTIX_TOKEN not configured')
      return c.json(
        { error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' },
        503,
      )
    }
    const auth = verifyKortixUserContext(
      c.req.header(KORTIX_USER_CONTEXT_HEADER),
      cfg.sandboxToken,
    )
    if (!auth.ok) {
      logger.warn('[opencode-acp] reject', {
        reason: auth.reason,
        path: new URL(c.req.url).pathname,
      })
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    }
    return next()
  })

  router.use('/:serverId', async (c, next) => {
    const canonicalSessionId = getCanonicalSessionId()
    if (!canonicalSessionId) {
      return c.json({ error: 'Canonical OpenCode session not ready' }, 503)
    }
    if (c.req.param('serverId') !== canonicalSessionId) {
      return c.json({ error: 'ACP session not found' }, 404)
    }
    return next()
  })

  router.post('/:serverId', async (c) => {
    if (
      !c.req
        .header('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    ) {
      return c.json({ error: 'content-type must be application/json' }, 415)
    }

    const connection = getConnection()
    if (!connection?.ready) {
      return c.json({ error: 'OpenCode ACP not ready' }, 503)
    }

    try {
      const envelope = parseJsonRpcEnvelope(await c.req.json())
      if ('method' in envelope) {
        if (!ALLOWED_SESSION_METHODS.has(envelope.method as string)) {
          return c.json({ error: 'ACP method is not allowed' }, 405)
        }
        const params =
          envelope.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
            ? (envelope.params as Record<string, unknown>)
            : {}
        if (params.sessionId !== c.req.param('serverId')) {
          return c.json({ error: 'ACP payload session does not match route session' }, 409)
        }
      }
      await connection.post(envelope)
      return c.body(null, 202)
    } catch (error) {
      const status = error instanceof AcpProtocolError ? 502 : 400
      return c.json({ error: errorMessage(error) }, status)
    }
  })

  router.get('/:serverId', (c) => {
    const connection = getConnection()
    if (!connection?.ready) {
      return c.json({ error: 'OpenCode ACP not ready' }, 503)
    }
    const accept = c.req.header('accept')
    if (
      accept &&
      !accept.includes('text/event-stream') &&
      !accept.includes('*/*')
    ) {
      return c.json({ error: 'accept must include text/event-stream' }, 406)
    }

    const rawLastEventId = c.req.header('last-event-id')?.trim()
    const lastEventId = rawLastEventId ? Number(rawLastEventId) : connection.lastEventId
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
      return c.json(
        { error: 'Last-Event-ID must be a non-negative integer' },
        400,
      )
    }

    let unsubscribe = () => {}
    let keepAlive: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (value: string) => {
          try {
            controller.enqueue(encoder.encode(value))
          } catch {}
        }
        write(
          `id: ${lastEventId}\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n`,
        )
        unsubscribe = connection.subscribe(
          lastEventId,
          (event) => {
            write(
              `id: ${event.id}\ndata: ${JSON.stringify(event.envelope)}\n\n`,
            )
          },
          () => {
            if (keepAlive) clearInterval(keepAlive)
            try {
              controller.close()
            } catch {}
          },
        )
        keepAlive = setInterval(() => write(': keepalive\n\n'), 15_000)
      },
      cancel() {
        if (keepAlive) clearInterval(keepAlive)
        unsubscribe()
      },
    })

    return new Response(body, {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  return router
}
