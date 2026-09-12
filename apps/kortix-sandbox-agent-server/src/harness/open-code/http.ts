import { requireOpenCodeConfig } from './config'
import { Hono } from 'hono'
import type { HarnessHttpContext, HarnessHttpService } from '../harness'
import { BOOT_PHASE_HEADER, bootPhaseLabel } from './boot-phase'
import { runtimeAssetsActivity, runtimeConvergenceReport } from '../../runtime-assets'
import { logger } from '../../logger'
import { isRepoMaterialized } from '../../git'
import { withSseKeepalive } from '../../sse-keepalive'
import type { Opencode } from './supervisor'
import { OPENCODE_HOME } from './paths'
import type { OpenCodeBootState } from './boot-state'
import { stripInlineAttachmentBytes } from './inline-attachments'
import { defaultSidecarDir, opencodeDbPath } from './attachment-offload'
import { readPinnedSessionId } from './opencode-turn-state'
import { OpencodeDb } from './opencode-db'
import { configureRuntimeState, runtimeStateStore } from './runtime-state-projection'
import { createHealthRouter } from './routes/health'
import { createRefreshRouter } from './routes/refresh'
import { createAbortRouter } from './routes/abort'
import { createEnvRouter } from './routes/env'
import { createPartRouter } from './routes/part'
import { createLogsRouter } from './routes/logs'
import { createDiagRouter } from './routes/diag'
import { createOpencodeRuntimeRouter } from './routes/opencode-runtime'

// Headers that must not be forwarded — they're connection-scoped or set by us.
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
])

const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection'])

// Bound on waiting for opencode to respond to a proxied request. Applied only
// to the wait for the response to arrive (headers), never to a streaming body
// already in flight — an SSE stream like /global/event legitimately stays open
// for the life of the session, so aborting on a fixed wall clock would sever
// healthy long-lived connections. A wedged opencode process (hung event loop,
// deadlock) otherwise leaves this `fetch` unresolved forever: the daemon's own
// `/kortix/health` stays green throughout (it never touches opencode), so
// nothing else catches it, and the browser just sees the request hang until
// something upstream (ALB/ingress) eventually resets the connection — which
// surfaces as a confusing "blocked by CORS" error with no real diagnostic
// value. Failing fast here instead gives a clean 502 that apps/api's own
// retry+auto-wake loop can act on immediately.
const UPSTREAM_RESPONSE_TIMEOUT_MS = 10_000

// The exception the bound above cannot express, and the omission that produced
// the "upstream unreachable" banner in chat (2026-08-11, session 9f6b0d87).
//
// The reasoning above holds for every endpoint that ANSWERS quickly and then
// maybe streams — SSE, downloads, long polls. It does not hold for the two that
// withhold headers until the work is DONE: opencode does not emit a byte of
// `POST /session/:id/message` or `POST /session/:id/command` until the entire
// reasoning + tool-call turn has finished. (`prompt_async` is the non-blocking
// sibling the web UI normally uses; `/command` has no async variant, so every
// `/` slash-command takes this path.)
//
// Bounding those at 10s does not detect a wedged opencode, it MANUFACTURES a
// failure out of a healthy turn: measured, a trivial `/command` takes ~6s and a
// real one minutes. Worse, the 502 it returns is the signal apps/api's retry
// loop was built to act on — so a fail-fast designed to trigger a retry met a
// retry loop that assumed idempotency, and one `/webapp` submit ran the agent
// four times, each retry aborting the turn the previous one had started.
//
// A generous ceiling rather than none: a genuinely wedged opencode must still
// be caught eventually, and apps/api's own 50s proxy budget already bounds what
// the browser waits for. This only stops the daemon severing a live turn first.
const LONG_TURN_RESPONSE_TIMEOUT_MS = 10 * 60_000

/**
 * Does opencode withhold this response until a whole turn completes?
 *
 * Mirrors `isLongTurnCompletionRequest` in
 * `apps/api/src/sandbox-proxy/preview-retry-budget.ts` — the two layers must
 * agree on which calls block, or the inner one aborts what the outer one is
 * patiently waiting for. Keep them in sync; there is no shared module because
 * the daemon ships inside the sandbox image and cannot import from apps/api.
 */
export function isBlockingTurnRequest(method: string, path: string): boolean {
  return (
    method.toUpperCase() === 'POST' &&
    /^\/session\/[^/]+\/(?:message|command|summarize)(?:$|[/?#])/.test(path)
  )
}

function mountControlRoutes(
  opencode: Opencode,
  kortixRouter: Hono,
  context: HarnessHttpContext,
): void {
  const { bootTime, bootState, projectEnv, staticWebPort, agentEnvFile, resources } = context
  const cfg = requireOpenCodeConfig(context.cfg)
  const healthRouter = createHealthRouter(cfg, opencode, bootTime, bootState, staticWebPort)
  const refreshRouter = createRefreshRouter(cfg, opencode)
  const abortRouter = createAbortRouter(cfg, opencode)
  const envRouter = projectEnv
    ? createEnvRouter(cfg, opencode, projectEnv, { agentEnvFile })
    : null
  kortixRouter.route('/health', healthRouter)
  kortixRouter.route('/health/', healthRouter)
  kortixRouter.route('/refresh', refreshRouter)
  kortixRouter.route('/refresh/', refreshRouter)
  kortixRouter.route('/abort', abortRouter)
  kortixRouter.route('/abort/', abortRouter)
  // /kortix/part — attachment bytes on demand; see routes/part.ts.
  const partRouter = createPartRouter(opencode, { sidecarDir: defaultSidecarDir(OPENCODE_HOME) })
  kortixRouter.route('/part', partRouter)
  kortixRouter.route('/part/', partRouter)
  // /kortix/logs — the daemon's own log file + OpenCode's; see routes/logs.ts.
  const logsRouter = createLogsRouter(cfg, { opencodeHome: OPENCODE_HOME })
  kortixRouter.route('/logs', logsRouter)
  kortixRouter.route('/logs/', logsRouter)
  // /kortix/diag — the whole error report in one JSON document; see routes/diag.ts.
  const diagRouter = createDiagRouter(cfg, {
    opencode,
    bootTime,
    bootState,
    opencodeHome: OPENCODE_HOME,
    resources,
  })
  kortixRouter.route('/diag', diagRouter)
  kortixRouter.route('/diag/', diagRouter)
  if (envRouter) {
    kortixRouter.route('/env', envRouter)
    kortixRouter.route('/env/', envRouter)
  }

  // /kortix/opencode/* — the Kortix Runtime API (routes/opencode-runtime.ts).
  //
  // ADDITIVE. The `/p/<box>/8000/...` passthrough below still serves every
  // OpenCode path it serves today; this namespace answers the same questions
  // in a projected, gzipped, SEQUENCED form so the product never has to speak
  // OpenCode's wire format or poll for a frame it might have missed.
  //
  // The store is a process singleton so `POST /kortix/env` and a verified
  // reload can invalidate it without threading a handle through the proxy —
  // `reload()` rebuilds this app on a warm-snapshot restore and must not orphan
  // the projection it was maintaining.
  const opencodeDb = new OpencodeDb(opencodeDbPath(OPENCODE_HOME))
  const runtimeState =
    runtimeStateStore() ??
    configureRuntimeState({
      opencode,
      cfg,
      db: opencodeDb,
      pinnedSessionId: readPinnedSessionId,
      daemonBuild: async () => (await runtimeConvergenceReport()).build,
    })
  const opencodeRuntimeRouter = createOpencodeRuntimeRouter(cfg, {
    opencode,
    db: opencodeDb,
    state: runtimeState,
    pinnedSessionId: readPinnedSessionId,
  })
  kortixRouter.route('/opencode', opencodeRuntimeRouter)
  kortixRouter.route('/opencode/', opencodeRuntimeRouter)

}

/** Native route semantics stay behind the selected harness service. */
export function createOpenCodeHttpService(opencode: Opencode): HarnessHttpService {
  return {
    mountControlRoutes: (router, context) => mountControlRoutes(opencode, router, context),
    blockedPorts: (cfg) => {
      const native = requireOpenCodeConfig(cfg)
      return [native.opencodeInternalPort, native.opencodeStandbyPort]
    },
    mountFallback(app, context) {
      mountFallback(opencode, app, context)
    },
  }
}

function mountFallback(opencode: Opencode, app: Hono, context: HarnessHttpContext): void {
  const cfg = requireOpenCodeConfig(context.cfg)
  const bootState: OpenCodeBootState = context.bootState
  // Reverse-proxy catch-all → OpenCode. Stream both directions so SSE works.
  // If opencode hasn't bound its port yet (state !== 'ok') we 503 instead of
  // attempting a fetch — surfaces the situation clearly to the client and
  // prevents noisy ECONNREFUSED loops.
  app.all('*', async (c) => {
    // Every not-ready answer names the boot phase (X-Kortix-Boot-Phase) so the
    // API's start budget measures lack of PROGRESS, not wall-clock. See
    // boot-phase.ts.
    const notReady = (body: Record<string, unknown>, reason: string) => {
      const phase = bootPhaseLabel({
        timeline: bootState.timeline,
        opencodeState: opencode.getState(),
        runtimeAssetsActivity: runtimeAssetsActivity(),
        notReadyReason: reason,
      })
      c.header(BOOT_PHASE_HEADER, phase)
      return c.json({ ...body, phase }, 503)
    }

    if (bootState.repoMaterializationError) {
      return notReady(
        {
          error: 'sandbox runtime not ready',
          reason: 'repo_materialization_failed',
          message: bootState.repoMaterializationError,
        },
        'repo_materialization_failed',
      )
    }

    if (cfg.autoClone && !(await isRepoMaterialized(cfg.projectTarget))) {
      return notReady(
        {
          error: 'sandbox runtime not ready',
          reason: 'repo_not_materialized',
        },
        'repo_not_materialized',
      )
    }
    // The checkout can be on disk while its config-dir dependencies are still
    // installing. A directory-scoped request in that window makes OpenCode
    // cache a tool registry whose imports failed, for the life of the process
    // (dev, 2026-08-27). Hold callers off until the workspace is complete.
    if (bootState.workspaceReady === false) {
      return notReady(
        {
          error: 'sandbox runtime not ready',
          reason: 'workspace_not_ready',
        },
        'workspace_not_ready',
      )
    }

    if (bootState.initialOpenCodeSessionError) {
      return notReady(
        {
          error: 'sandbox runtime not ready',
          reason: 'initial_opencode_session_failed',
          message: bootState.initialOpenCodeSessionError,
        },
        'initial_opencode_session_failed',
      )
    }

    if (bootState.initialOpenCodeSessionRequired && !bootState.initialOpenCodeSessionId) {
      return notReady(
        {
          error: 'sandbox runtime not ready',
          reason: 'initial_opencode_session_pending',
        },
        'initial_opencode_session_pending',
      )
    }

    if (opencode.getState() !== 'ok') {
      return notReady(
        {
          error: 'opencode not ready',
          opencode: opencode.getState(),
        },
        'opencode_not_ready',
      )
    }

    const url = new URL(c.req.url)
    const upstreamUrl = `${opencode.getInternalUrl()}${url.pathname}${url.search}`

    const headers = new Headers()
    c.req.raw.headers.forEach((value, key) => {
      if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value)
    })

    const method = c.req.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD'

    // Bound only the wait for opencode's response (headers) — not the abort
    // controller's whole lifetime — so we can free-run a stream once it starts.
    // Clearing the timer right after `fetch` resolves means the controller can
    // never fire again, so a long-lived SSE body already in flight (e.g.
    // /global/event) is never cut off mid-stream.
    const controller = new AbortController()
    const responseTimeoutMs = isBlockingTurnRequest(method, url.pathname)
      ? LONG_TURN_RESPONSE_TIMEOUT_MS
      : UPSTREAM_RESPONSE_TIMEOUT_MS
    const responseTimer = setTimeout(() => controller.abort(), responseTimeoutMs)
    try {
      const fetchInit: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        body: hasBody ? (c.req.raw.body as ReadableStream | null) : undefined,
        // duplex: 'half' is required by undici when piping a ReadableStream body;
        // Bun accepts the extra key too. Not in lib.dom RequestInit yet.
        duplex: 'half',
        signal: controller.signal,
      }
      const upstream = await fetch(upstreamUrl, fetchInit)
      clearTimeout(responseTimer)

      const respHeaders = new Headers()
      upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) respHeaders.set(key, value)
      })

      // The transcript list leaves this box WITHOUT its attachment bytes.
      //
      // Every `data:` url in a file part is the whole file, base64'd, and the
      // list re-ships every one of them on every read. Measured on a real
      // session (essentia, 2026-08-24): 20 messages = 7-19 MB, reads dying on
      // the browser's 30s deadline, and a retry re-issuing the whole thing.
      // The same read answered here, in-VM, in 276 ms — the cost was entirely
      // the bytes leaving. They now leave one part at a time, on demand, via
      // /kortix/part (see routes/part.ts). Buffering the JSON here is cheap
      // for the same reason: it is the in-VM copy.
      const listMatch = method === 'GET' && upstream.ok
        ? /^\/session\/([^/]+)\/message\/?$/.exec(url.pathname)
        : null
      if (listMatch && (upstream.headers.get('content-type') ?? '').includes('application/json')) {
        const sessionID = decodeURIComponent(listMatch[1] ?? '')
        const text = await upstream.text()
        let body = text
        try {
          const stripped = stripInlineAttachmentBytes(
            JSON.parse(text),
            (messageID, partID) =>
              `/kortix/part/${encodeURIComponent(sessionID)}/${encodeURIComponent(messageID)}/${encodeURIComponent(partID)}`,
          )
          if (stripped.stripped > 0) {
            body = JSON.stringify(stripped.value)
            logger.info('[proxy] stripped inline attachment bytes from message list', {
              sessionID,
              parts: stripped.stripped,
              savedBytes: stripped.savedBytes,
              bytes: body.length,
            })
          }
        } catch {
          // Not the JSON we expected — pass it through untouched. This path
          // must never be the reason a transcript read fails.
        }
        respHeaders.delete('content-length')
        respHeaders.delete('content-encoding')
        respHeaders.set('content-type', 'application/json; charset=utf-8')
        return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders })
      }

      // SSE gets a keepalive-injecting passthrough. This proxy is one
      // localhost hop from opencode, so a keepalive it emits proves the whole
      // daemon → edge → api → browser path — the path that used to die
      // silently (stale ingress answering 200 and never writing, edge stalls,
      // the ALB's idle timeout) with the SDK's 60s heartbeat as the only
      // detector. See `sse-keepalive.ts` for the wire-format rules.
      const upstreamContentType = upstream.headers.get('content-type') ?? ''
      if (upstream.ok && upstream.body && upstreamContentType.includes('text/event-stream')) {
        respHeaders.delete('content-length')
        return new Response(withSseKeepalive(upstream.body), {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: respHeaders,
        })
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      })
    } catch (err) {
      clearTimeout(responseTimer)
      const timedOut = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      if (timedOut) {
        logger.error('[proxy] upstream fetch timed out — opencode unresponsive', {
          path: url.pathname,
          timeoutMs: responseTimeoutMs,
        })
      } else {
        logger.error('[proxy] upstream fetch failed', err)
      }
      return c.json({ error: 'upstream unreachable', details: (err as Error).message }, 502)
    }
  })

}
