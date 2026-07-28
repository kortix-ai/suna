import { Hono } from 'hono'

import {
  AcpProtocolError,
  parseJsonRpcEnvelope,
  type AcpConnection,
} from '../acp/connection'
import {
  parseAcpHarnessId,
  type AcpHarnessId,
} from '../acp/harness-registry'
import {
  AcpHarnessConflictError,
  AcpUpstreamError,
  type AcpRuntime,
  type AcpRuntimeProcess,
} from '../acp/runtime'
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
  'session/revert',
  'session/unrevert',
])

export interface AcpSessionHistory {
  revert(sessionId: string, messageId: string): Promise<unknown>
  unrevert(sessionId: string): Promise<unknown>
}

type HistoryFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

class OpenCodeSessionHistoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown,
  ) {
    super(message)
    this.name = 'OpenCodeSessionHistoryError'
  }
}

export function createOpenCodeSessionHistory(
  cfg: Pick<Config, 'workspace'>,
  getInternalUrl: () => string,
  fetcher: HistoryFetch = fetch,
): AcpSessionHistory {
  const invoke = async (
    sessionId: string,
    action: 'revert' | 'unrevert',
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    const response = await fetcher(
      `${getInternalUrl()}/session/${encodeURIComponent(sessionId)}/${action}?directory=${encodeURIComponent(cfg.workspace)}`,
      {
        method: 'POST',
        ...(body
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      },
    )
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new OpenCodeSessionHistoryError(
        `OpenCode session ${action} failed with HTTP ${response.status}`,
        response.status,
        data,
      )
    }
    return data
  }

  return {
    revert: (sessionId, messageId) => invoke(sessionId, 'revert', { messageID: messageId }),
    unrevert: (sessionId) => invoke(sessionId, 'unrevert'),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAcpRouter(
  cfg: Config,
  getConnection: () => AcpConnection | null,
  getCanonicalSessionId: () => string | null,
  history?: AcpSessionHistory,
  runtime?: AcpRuntime,
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

  const getOpenCodeConnection = (
    serverId: string,
  ):
    | { connection: AcpConnection; error?: never }
    | { connection?: never; error: Response } => {
    const canonicalSessionId = getCanonicalSessionId()
    if (!canonicalSessionId) {
      return {
        error: Response.json(
          { error: 'Canonical OpenCode session not ready' },
          { status: 503 },
        ),
      }
    }
    if (serverId !== canonicalSessionId) {
      return {
        error: Response.json(
          { error: 'ACP session not found' },
          { status: 404 },
        ),
      }
    }
    const connection = getConnection()
    if (!connection?.ready) {
      return {
        error: Response.json(
          { error: 'OpenCode ACP not ready' },
          { status: 503 },
        ),
      }
    }
    return { connection }
  }

  const resolveRuntimeProcess = async (
    serverId: string,
    harness: AcpHarnessId | null,
  ): Promise<AcpRuntimeProcess | null> => {
    const existing = runtime?.get(serverId)
    if (existing) {
      if (harness && existing.harness !== harness) {
        throw new AcpHarnessConflictError(
          serverId,
          existing.harness,
          harness,
        )
      }
      return existing
    }
    if (!runtime || !harness || harness === 'opencode') return null
    return runtime.getOrCreate(serverId, harness)
  }

  router.get('/', (c) =>
    c.json({ servers: runtime?.list() ?? [] }),
  )

  router.post('/:serverId', async (c) => {
    if (
      !c.req
        .header('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    ) {
      return c.json({ error: 'content-type must be application/json' }, 415)
    }

    const rawAgent = c.req.query('agent')
    const harness = parseAcpHarnessId(rawAgent)
    if (rawAgent && !harness) {
      return c.json(
        { error: `unsupported ACP agent '${rawAgent}'` },
        400,
      )
    }

    try {
      const envelope = parseJsonRpcEnvelope(await c.req.json())
      const managed = await resolveRuntimeProcess(
        c.req.param('serverId'),
        harness,
      )
      if (managed) {
        const response = await managed.post(envelope)
        return response ? c.json(response) : c.body(null, 202)
      }

      if (
        runtime &&
        !harness &&
        getCanonicalSessionId() &&
        c.req.param('serverId') !== getCanonicalSessionId()
      ) {
        return c.json(
          {
            error:
              "first POST must include agent=claude, agent=codex, or agent=pi",
          },
          400,
        )
      }

      const target = getOpenCodeConnection(
        c.req.param('serverId'),
      )
      if (target.error) return target.error
      const connection = target.connection

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
        if (
          (envelope.method === 'session/revert' || envelope.method === 'session/unrevert') &&
          Object.prototype.hasOwnProperty.call(envelope, 'id')
        ) {
          if (!history) {
            return c.json({ error: 'ACP session history is not available' }, 503)
          }
          if (
            envelope.method === 'session/revert' &&
            (typeof params.messageId !== 'string' || !params.messageId)
          ) {
            return c.json({
              jsonrpc: '2.0',
              id: envelope.id,
              error: { code: -32602, message: 'messageId is required' },
            })
          }
          try {
            const result =
              envelope.method === 'session/revert'
                ? await history.revert(c.req.param('serverId'), params.messageId as string)
                : await history.unrevert(c.req.param('serverId'))
            return c.json({ jsonrpc: '2.0', id: envelope.id, result })
          } catch (error) {
            return c.json({
              jsonrpc: '2.0',
              id: envelope.id,
              error: {
                code: -32000,
                message: errorMessage(error),
                ...(error instanceof OpenCodeSessionHistoryError
                  ? { data: { status: error.status, upstream: error.data } }
                  : {}),
              },
            })
          }
        }
      }
      await connection.post(envelope)
      return c.body(null, 202)
    } catch (error) {
      if (error instanceof AcpHarnessConflictError) {
        return c.json({ error: error.message }, 409)
      }
      if (error instanceof AcpUpstreamError) {
        return c.json({ error: error.message }, 502)
      }
      const status = error instanceof AcpProtocolError ? 502 : 400
      return c.json({ error: errorMessage(error) }, status)
    }
  })

  router.get('/:serverId', (c) => {
    const rawAgent = c.req.query('agent')
    const harness = parseAcpHarnessId(rawAgent)
    if (rawAgent && !harness) {
      return c.json(
        { error: `unsupported ACP agent '${rawAgent}'` },
        400,
      )
    }

    const managed = runtime?.get(c.req.param('serverId'))
    const target = managed
      ? { connection: managed.connection }
      : getOpenCodeConnection(c.req.param('serverId'))
    if (target.error) return target.error
    const connection = target.connection

    if (managed && harness && managed.harness !== harness) {
      return c.json(
        {
          error: new AcpHarnessConflictError(
            managed.serverId,
            managed.harness,
            harness,
          ).message,
        },
        409,
      )
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

  router.delete('/:serverId', async (c) => {
    await runtime?.delete(c.req.param('serverId'))
    return c.body(null, 204)
  })

  return router
}
