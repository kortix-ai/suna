import { Hono } from 'hono'

import { parseAcpHarnessId } from '../acp/harness-registry'
import {
  AcpHarnessConflictError,
  AcpUpstreamError,
  type AcpRuntime,
  parseJsonRpcEnvelope,
} from '../acp/runtime'

const encoder = new TextEncoder()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAcpRouter(runtime: AcpRuntime): Hono {
  const router = new Hono()

  router.get('/', (c) => c.json({ servers: runtime.list() }))

  router.post('/:serverId', async (c) => {
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'content-type must be application/json' }, 415)
    }

    const rawAgent = c.req.query('agent')
    const harness = parseAcpHarnessId(rawAgent)
    if (rawAgent && !harness) {
      return c.json({ error: `unsupported ACP agent '${rawAgent}'` }, 400)
    }

    try {
      const envelope = parseJsonRpcEnvelope(await c.req.json())
      const instance = await runtime.getOrCreate(c.req.param('serverId'), harness)
      const response = await instance.post(envelope)
      return response ? c.json(response) : c.body(null, 202)
    } catch (error) {
      if (error instanceof AcpHarnessConflictError) {
        return c.json({ error: error.message }, 409)
      }
      if (error instanceof AcpUpstreamError) {
        return c.json({ error: error.message }, 502)
      }
      return c.json({ error: errorMessage(error) }, 400)
    }
  })

  router.get('/:serverId', (c) => {
    const instance = runtime.get(c.req.param('serverId'))
    if (!instance) return c.json({ error: 'ACP server not found' }, 404)
    const accept = c.req.header('accept')
    if (accept && !accept.includes('text/event-stream') && !accept.includes('*/*')) {
      return c.json({ error: 'accept must include text/event-stream' }, 406)
    }

    const rawLastEventId = c.req.header('last-event-id')?.trim()
    const lastEventId = rawLastEventId ? Number(rawLastEventId) : 0
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
      return c.json({ error: 'Last-Event-ID must be a non-negative integer' }, 400)
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
        // Flush response headers immediately even when the replay buffer is
        // empty; otherwise some HTTP runtimes wait for the first agent event
        // before resolving the client's GET.
        write(': connected\n\n')
        unsubscribe = instance.subscribe(
          lastEventId,
          (event) => {
            write(`id: ${event.id}\ndata: ${JSON.stringify(event.envelope)}\n\n`)
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
    await runtime.delete(c.req.param('serverId'))
    return c.body(null, 204)
  })

  return router
}
