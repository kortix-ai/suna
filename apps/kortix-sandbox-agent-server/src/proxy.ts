import { Hono } from 'hono'
import { BOOT_PHASE_HEADER, bootPhaseLabel } from './boot-phase'
import { runtimeAssetsActivity } from './runtime-assets'
import { egressShimPort } from './egress-shim'
import type { ServerWebSocket } from 'bun'

import type { Config } from './config'
import { logger } from './logger'
import { createPartRouter } from './routes/part'
import { stripInlineAttachmentBytes } from './inline-attachments'
import { withSseKeepalive } from './sse-keepalive'
import type { Opencode } from './opencode'
import { isRepoMaterialized } from './git'
import { createHealthRouter, type SandboxBootState } from './routes/health'
import { createRefreshRouter } from './routes/refresh'
import { createLogsRouter } from './routes/logs'
import { createDiagRouter } from './routes/diag'
import { type ResourceMonitor, startResourceMonitor } from './resources'
import { defaultSidecarDir, opencodeDbPath, runAttachmentOffloadPass } from './attachment-offload'
import { opencodeTurnInFlight, readPinnedSessionId } from './opencode-turn-state'
import { OPENCODE_HOME } from './opencode'
import { createAbortRouter } from './routes/abort'
import { createEnvRouter } from './routes/env'
import { createGitRouter } from './routes/git'
import { createPortProxyRouter } from './routes/port-proxy'
import { createFilesRouter } from './routes/files'
import { createFindRouter } from './routes/find'
import { createPresentationRouter } from './routes/presentation'
import { createWebProxyRouter } from './routes/web-proxy'
import { createPtyRegistry, createPtyRouter, type PtyAttachHandle, type PtyRegistry } from './routes/pty'
import { registerAgentSwapBlocker } from './runtime-assets'
import type { ProjectEnvStore } from './project-env'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from './kortix-user-context'

// Headers that must not be forwarded — they're connection-scoped or set by us.
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
])

const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection'])

// The id segment is optional: connecting with no id (or an id the daemon
// doesn't recognize) still opens a working terminal — see the lookup-or-
// create handling in the `open` websocket handler below.
const KORTIX_PTY_WS_PATH_RE = /^\/kortix\/pty(?:\/([^/]+))?\/connect\/?$/
const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context'

// One per process: the periodic box telemetry (resources.ts). Started by
// startProxy, read by /kortix/diag. Null in unit tests that build the app only.
let resourceMonitor: ResourceMonitor | null = null

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

type OpencodeWsData = {
  // Absent when the client connects without an id — lookup-or-create then
  // mints a brand new pty (see `websocket.open` below).
  ptyId?: string
  handle?: PtyAttachHandle
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// The Kortix-native PTY WS upgrade — independent of opencode/repo readiness
// entirely (it just spawns a shell), unlike the (now removed) opencode-
// proxied path this replaced: a raw terminal works even while the repo is
// still cloning or opencode hasn't come up yet.
function prepareKortixPtyWsUpgrade(
  req: Request,
  cfg: Config,
): { ok: true; data: OpencodeWsData } | { ok: false; response: Response } {
  const url = new URL(req.url)
  const match = KORTIX_PTY_WS_PATH_RE.exec(url.pathname)
  if (!match) {
    return { ok: false, response: jsonError(404, { error: 'unsupported websocket path' }) }
  }
  // Absent when the client connects with no id segment at all (e.g.
  // `/kortix/pty/connect`) — lookup-or-create mints a fresh pty either way.
  const ptyId = match[1]

  if (!cfg.sandboxToken) {
    logger.warn('[pty] rejecting websocket: KORTIX_TOKEN not configured')
    return {
      ok: false,
      response: jsonError(503, { error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }),
    }
  }

  const header = req.headers.get(KORTIX_USER_CONTEXT_HEADER) ?? url.searchParams.get(KORTIX_USER_CONTEXT_QUERY_PARAM)
  const auth = verifyKortixUserContext(header, cfg.sandboxToken)
  if (!auth.ok) {
    logger.warn('[pty] reject websocket', { reason: auth.reason, path: url.pathname })
    return { ok: false, response: jsonError(401, { error: 'unauthorized', reason: auth.reason }) }
  }

  return { ok: true, data: { ptyId } }
}

export function buildOpencodeApp(
  cfg: Config,
  opencode: Opencode,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
  ptyRegistry?: PtyRegistry,
  agentEnvFile?: string,
): Hono {
  const app = new Hono()

  // The daemon owns a small Kortix-namespaced control surface. Everything else is
  // pure passthrough to opencode. Mount at both `/health` and `/health/` so
  // a trailing slash doesn't fall through to the reverse proxy.
  // Health bypasses auth — it's how the cloud probes liveness mid-boot.
  const kortixRouter = new Hono()
  const healthRouter = createHealthRouter(cfg, opencode, bootTime, bootState, staticWebPort)
  const refreshRouter = createRefreshRouter(cfg, opencode)
  const abortRouter = createAbortRouter(cfg, opencode)
  const envRouter = projectEnv
    ? createEnvRouter(cfg, opencode, projectEnv, { agentEnvFile })
    : null
  // NOTE: /kortix/git is currently unused by the product (the agent commits +
  // opens change requests from a chat prompt). Kept as a host-driven primitive.
  const gitRouter = createGitRouter(cfg)
  // /kortix/pty — Kortix's own terminal, independent of opencode entirely
  // (see routes/pty.ts). `ptyRegistry` is always passed by `startProxy`;
  // the parameter is optional only so tests can build the app without one.
  const ptyRouter = createPtyRouter(cfg, ptyRegistry ?? createPtyRegistry(cfg))
  kortixRouter.route('/health', healthRouter)
  kortixRouter.route('/health/', healthRouter)
  kortixRouter.route('/refresh', refreshRouter)
  kortixRouter.route('/refresh/', refreshRouter)
  kortixRouter.route('/abort', abortRouter)
  kortixRouter.route('/abort/', abortRouter)
  kortixRouter.route('/git', gitRouter)
  kortixRouter.route('/git/', gitRouter)
  kortixRouter.route('/pty', ptyRouter)
  kortixRouter.route('/pty/', ptyRouter)
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
    resources: () => resourceMonitor,
  })
  kortixRouter.route('/diag', diagRouter)
  kortixRouter.route('/diag/', diagRouter)
  if (envRouter) {
    kortixRouter.route('/env', envRouter)
    kortixRouter.route('/env/', envRouter)
  }

  app.route('/kortix', kortixRouter)

  // Auth gate for everything except /kortix/*. Spec §3.5: the daemon MUST
  // validate X-Kortix-User-Context (HMAC-signed by the API with KORTIX_TOKEN)
  // before forwarding to opencode. Without a configured token the daemon is
  // an open door; we log loudly at boot and reject all proxied requests until
  // KORTIX_TOKEN is provided.
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/kortix/')) return next()

    if (!cfg.sandboxToken) {
      logger.warn('[proxy] rejecting request: KORTIX_TOKEN not configured')
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }

    const header = c.req.header(KORTIX_USER_CONTEXT_HEADER)
    const result = verifyKortixUserContext(header, cfg.sandboxToken)
    if (!result.ok) {
      logger.warn('[proxy] reject', { reason: result.reason, path })
      return c.json({ error: 'unauthorized', reason: result.reason }, 401)
    }

    return next()
  })

  // /proxy/{port}/* — per-port reverse proxy to anything bound on localhost
  // inside the sandbox (the "internal browser" backend). Carried over from
  // legacy kortix-master so any process the agent starts (e.g. `python -m
  // http.server 8080`) is reachable via /v1/p/{sandboxId}/{port}/* on the API.
  // The agent server's own port is blocked to prevent recursion; opencode's
  // internal port is reachable via the catch-all below, not /proxy.
  const portProxyRouter = createPortProxyRouter({
    // The egress shim too. It already refuses a plain-HTTP request with 405
    // (it is CONNECT-only) and its per-host TLS listeners reject an HTTP dial,
    // so this closes a door that is bolted — but the shim is the one listener
    // in the guest whose job is to sit in front of a credential, and "it fails
    // closed today" is a weaker guarantee than "it is not routable".
    blockedPorts: new Set([cfg.servicePort, egressShimPort()]),
  })
  app.route('/proxy', portProxyRouter)

  // /web-proxy/{scheme}/{host}/{path} — forward proxy that rewrites HTML/CSS
  // so external sites embed cleanly inside the internal browser iframe.
  //
  // Blocked loopback ports keep it off our own control plane: reaching the
  // daemon or opencode through here would tunnel past every path-keyed control
  // apps/api applies on the way in (agent authorization, connector gate, run
  // cap, prompt idempotency, secret-grant re-mint).
  app.route(
    '/web-proxy',
    createWebProxyRouter({
      // BOTH halves of the opencode port pair. A verified reload swaps which
      // one is live, and this set is built once — blocking only the current
      // half would leave the other reachable the moment they trade places.
      blockedSelfPorts: new Set([
        cfg.servicePort,
        egressShimPort(),
        cfg.opencodeInternalPort,
        cfg.opencodeStandbyPort,
      ]),
    }),
  )

  // /file/* — the daemon owns the ENTIRE file API: reads (GET / list,
  // /content, /raw, /status) and writes (upload, delete, mkdir, rename). We do
  // NOT forward file reads to OpenCode — its /file/content base64-inlines
  // images only and returns empty content for every other binary, breaking
  // Office-doc/PDF previews and downloads. Serving off disk here is correct for
  // all types. (/project/current + /global/health still fall through.)
  app.route('/file', createFilesRouter(cfg))

  // /find/* — daemon-served search (file-by-name + ripgrep text search), also
  // formerly forwarded to OpenCode.
  app.route('/find', createFindRouter(cfg))

  // /presentation/* — on-demand PDF/PPTX export for the slide-deck viewer's
  // download buttons. Runs the conversion in the background and answers each
  // poll fast (202 while generating, 200 + the file when ready) so it never
  // trips the apps/api preview-proxy's per-attempt timeout. See the router doc.
  app.route('/presentation', createPresentationRouter(cfg))

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

  return app
}

export type ProxyServer = {
  stop(): Promise<void>
  port: number
  // Rebuild the control surface with a new Config. A warm snapshot seed boots
  // with seed-time credentials and only learns its forked session cfg after
  // restore; without this the proxy auth gate + routers keep the seed cfg.
  reload(next: Config): void
}

export function startProxy(
  cfg: Config,
  opencode: Opencode,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
): ProxyServer {
  // Mutable so restore-time reload() can hot-swap the handler in place; the
  // indirection below re-reads `app` per request, so reassigning it is enough.
  let currentCfg = cfg
  // Constructed once, outside reload() — pty state must survive a config
  // hot-swap (warm-snapshot restore) exactly like `opencode`/`bootState` do.
  const ptyRegistry = createPtyRegistry(cfg)
  // Box telemetry: a `[resources]` log line every minute and on every
  // opencode state change, `[resources] pressure` when a threshold is crossed.
  resourceMonitor?.stop()
  const turnInFlight = () => opencodeTurnInFlight(opencode.getInternalUrl(), cfg.workspace)
  // Attachment offload (attachment-offload.ts): inline image bytes out of the
  // transcript store, only while no turn runs. Every 5 min, and right after a
  // memory-guard abort.
  const offloadDbPath = opencodeDbPath(OPENCODE_HOME)
  const offloadSidecarDir = defaultSidecarDir(OPENCODE_HOME)
  let offloadRunning = false
  const runOffloadIfIdle = async (why: string): Promise<void> => {
    if (offloadRunning) return
    if (process.env.KORTIX_ATTACHMENT_OFFLOAD === '0') return
    offloadRunning = true
    try {
      if ((await turnInFlight()) !== false) return
      const result = await runAttachmentOffloadPass({ dbPath: offloadDbPath, sidecarDir: offloadSidecarDir })
      if (result.offloaded > 0) logger.info('[offload] moved attachment bytes out of the transcript', { why, ...result })
    } catch (err) {
      logger.warn('[offload] pass threw', { err: (err as Error).message })
    } finally {
      offloadRunning = false
    }
  }
  const offloadTimer = setInterval(() => void runOffloadIfIdle('interval'), 5 * 60_000)
  offloadTimer.unref?.()
  setTimeout(() => void runOffloadIfIdle('boot'), 90_000).unref?.()

  resourceMonitor = startResourceMonitor({
    opencodePid: () => opencode.getPid(),
    opencodeState: () => opencode.getState(),
    diskPaths: [cfg.workspace, '/opt/kortix', '/tmp'],
    guard: {
      guardPct: Number(process.env.KORTIX_MEMORY_GUARD_PCT) || undefined,
      turnInFlight,
      abortTurn: async (reason) => {
        const sessionId = readPinnedSessionId()
        if (!sessionId) return false
        const url =
          `${opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/abort` +
          `?directory=${encodeURIComponent(cfg.workspace)}`
        logger.error('[resources] memory guard aborting the running turn', { sessionId, reason })
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) })
        return res.ok
      },
      onGuard: async ({ reason, snapshot, aborted }) => {
        // Tell the control plane in the same words the UI already renders for
        // a turn that ended in error, BEFORE OpenCode's own `session.error`
        // ("Aborted") can claim the turn end — the first end wins.
        await relayMemoryGuardTurnEnd({ reason, aborted, opencodeRssMb: snapshot.opencode?.rssMb ?? null })
        void runOffloadIfIdle('memory-guard')
      },
    },
  })
  // A staged daemon update must not exit this process while somebody has a
  // terminal open — the PTY dies with the daemon that spawned it. The registry
  // is the only thing that knows, so it answers the question rather than the
  // updater guessing at it. A busy box just keeps the staging: the supervisor
  // installs it at the next start.
  registerAgentSwapBlocker('pty', () =>
    ptyRegistry.list().some((entry) => entry.status === 'running'),
  )
  let app = buildOpencodeApp(cfg, opencode, bootTime, bootState, projectEnv, staticWebPort, ptyRegistry)

  const server = Bun.serve<OpencodeWsData>({
    port: cfg.servicePort,
    hostname: '0.0.0.0',
    // SSE streams from OpenCode can be long-lived with no traffic; default 10s
    // kills them. idleTimeout DISABLED (0): Bun's max is 255s AND Bun does not
    // reset idleTimeout on server->client stream writes, so a 255s ceiling still
    // killed long-lived low-traffic SSE mid-stream. 0 hands lifetime to the
    // stream itself / a real client disconnect (still aborts req.signal).
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
      if (isWsUpgrade && KORTIX_PTY_WS_PATH_RE.test(url.pathname)) {
        const prep = prepareKortixPtyWsUpgrade(req, currentCfg)
        if (!prep.ok) return prep.response
        const upgraded = srv.upgrade(req, { data: prep.data })
        if (upgraded) return undefined
        return jsonError(500, { error: 'websocket upgrade failed' })
      }
      return app.fetch(req, srv)
    },
    websocket: {
      // Lookup-or-create: a normal "open a terminal" must always succeed
      // with a working shell. A requested id that names a running pty
      // reattaches (a genuine reconnect resumes the same shell +
      // scrollback). A missing/unknown/absent id — the daemon restarted
      // and forgot its in-memory registry, a stale id survived a reload, or
      // no id was supplied at all — mints a fresh pty instead of hard-
      // closing with "pty not found". Only a *known-exited* pty (the shell
      // itself ended, e.g. the user typed `exit`) closes without recreating
      // — that's a real end-of-session the client should surface, not
      // silently paper over.
      open(ws: ServerWebSocket<OpencodeWsData>) {
        const state = ws.data
        const requestedId = state.ptyId
        const result = ptyRegistry.attachOrCreate(requestedId, {
          onData: (chunk) => {
            try { ws.send(chunk) } catch {}
          },
          onExit: (exitCode) => {
            try { ws.close(1000, `pty exited${exitCode === null ? '' : ` (${exitCode})`}`) } catch {}
          },
        })
        if (result.kind === 'exited') {
          try {
            ws.close(1000, `pty exited${result.meta.exitCode === undefined ? '' : ` (${result.meta.exitCode})`}`)
          } catch {}
          return
        }
        state.ptyId = result.meta.id
        state.handle = result.handle
        if (result.kind === 'created') {
          logger.info('[proxy] pty websocket lookup-or-create minted a new pty', {
            requestedId: requestedId ?? null,
            id: result.meta.id,
          })
        }
        if (result.handle.replay) {
          try { ws.send(result.handle.replay) } catch {}
        }
      },
      message(ws: ServerWebSocket<OpencodeWsData>, message: string | Buffer) {
        ws.data.handle?.write(typeof message === 'string' ? message : message.toString())
      },
      close(ws: ServerWebSocket<OpencodeWsData>) {
        ws.data.handle?.detach()
      },
    },
  })

  const boundPort = server.port ?? cfg.servicePort
  logger.info('[proxy] listening', { port: boundPort, hostname: '0.0.0.0' })

  return {
    port: boundPort,
    reload(next: Config) {
      currentCfg = next
      app = buildOpencodeApp(next, opencode, bootTime, bootState, projectEnv, staticWebPort, ptyRegistry)
      logger.info('[proxy] reloaded with session config', { projectId: next.projectId })
    },
    async stop() {
      server.stop(true)
    },
  }
}

/**
 * Report a memory-guard abort to apps/api as the turn's end, in the shape
 * the turn-stream already accepts (`kind: 'end'`, `status: 'error'`), so the
 * ledger records `failed` with a reason that names memory and the UI shows
 * it. Sent BEFORE the abort lands: OpenCode's own `session.error` ("Aborted")
 * follows, and the turn-stream keeps the first end for a turn.
 */
export async function relayMemoryGuardTurnEnd(input: {
  reason: string
  aborted: boolean
  opencodeRssMb: number | null
}): Promise<boolean> {
  const projectId = process.env.KORTIX_PROJECT_ID
  const sessionId = process.env.KORTIX_SESSION_ID
  const token = process.env.KORTIX_TOKEN
  const apiUrl = (process.env.KORTIX_API_URL ?? '').replace(/\/+$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) return false
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  try {
    const res = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        kind: 'end',
        status: 'error',
        opencode_session_id: readPinnedSessionId() ?? undefined,
        error_name: 'SandboxMemoryGuard',
        error_message: input.reason,
        error_retryable: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    logger.warn('[resources] memory guard relayed to the control plane', {
      status: res.status,
      aborted: input.aborted,
      opencodeRssMb: input.opencodeRssMb,
    })
    return res.ok
  } catch (err) {
    logger.warn('[resources] memory guard relay failed', { err: (err as Error).message })
    return false
  }
}
