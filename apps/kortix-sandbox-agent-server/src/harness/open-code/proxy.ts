import { requireOpenCodeConfig } from './config'
import type { HarnessProxyService } from '../proxy'
import { bootPhaseLabel } from './boot-phase'
import { runtimeAssetsActivity } from '../../runtime-assets'
import { logger } from '../../logger'
import { isRepoMaterialized } from '../../git'
import type { Opencode } from './lifecycle'
import type { OpenCodeBootState } from './boot-state'
import { stripInlineAttachmentBytes } from '../../inline-attachments'
import { openPartText } from './open-part-text'

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

/** Native readiness and upstream protocol handling, without route registration. */
export function createOpenCodeProxyService(opencode: Opencode): HarnessProxyService {
  return {
    blockedPorts(cfg) {
      const native = requireOpenCodeConfig(cfg)
      return [native.opencodeInternalPort, native.opencodeStandbyPort]
    },
    async readiness(context) {
      const cfg = requireOpenCodeConfig(context.cfg)
      const bootState: OpenCodeBootState = context.bootState
      const notReady = (body: Record<string, unknown>, reason: string) => {
        const phase = bootPhaseLabel({
          timeline: bootState.timeline,
          opencodeState: opencode.getState(),
          runtimeAssetsActivity: runtimeAssetsActivity(),
          notReadyReason: reason,
        })
        return { ready: false as const, phase, details: body }
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
      return { ready: true }
    },
    async forward(input) {
      const upstreamUrl = `${opencode.getInternalUrl()}${input.path}${input.search}`
      const method = input.method.toUpperCase()
      const hasBody = method !== 'GET' && method !== 'HEAD'

      // Bound only the wait for opencode's response (headers) — not the abort
      // controller's whole lifetime — so we can free-run a stream once it starts.
      // Clearing the timer right after `fetch` resolves means the controller can
      // never fire again, so a long-lived SSE body already in flight (e.g.
      // /global/event) is never cut off mid-stream.
      const controller = new AbortController()
      const responseTimeoutMs = isBlockingTurnRequest(method, input.path)
        ? LONG_TURN_RESPONSE_TIMEOUT_MS
        : UPSTREAM_RESPONSE_TIMEOUT_MS
      const responseTimer = setTimeout(() => controller.abort(), responseTimeoutMs)
      try {
        const fetchInit: RequestInit & { duplex?: 'half' } = {
          method,
          headers: input.headers,
          body: hasBody ? input.body : undefined,
          // duplex: 'half' is required by undici when piping a ReadableStream body;
          // Bun accepts the extra key too. Not in lib.dom RequestInit yet.
          duplex: 'half',
          signal: controller.signal,
        }
        const upstream = await fetch(upstreamUrl, fetchInit)
        clearTimeout(responseTimer)

        const respHeaders = new Headers(upstream.headers)

        // The transcript list leaves this box WITHOUT its attachment bytes.
        //
        // Every `data:` url in a file part is the whole file, base64'd, and the
        // list re-ships every one of them on every read. Measured on a real
        // session (2026-08-24): 20 messages = 7-19 MB, reads dying on
        // the browser's 30s deadline, and a retry re-issuing the whole thing.
        // The same read answered here, in-VM, in 276 ms — the cost was entirely
        // the bytes leaving. They now leave one part at a time, on demand, via
        // /kortix/part (see routes/part.ts). Buffering the JSON here is cheap
        // for the same reason: it is the in-VM copy.
        const listMatch = method === 'GET' && upstream.ok
          ? /^\/session\/([^/]+)\/message\/?$/.exec(input.path)
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
            // An OPEN text/reasoning part is persisted empty until it ends; carry
            // the text streamed so far instead (see open-part-text.ts), so a
            // reload mid-step reads the answer it just watched stream in.
            const inFlight = openPartText().overlay(stripped.value)
            if (stripped.stripped > 0 || inFlight > 0) {
              body = JSON.stringify(stripped.value)
            }
            if (stripped.stripped > 0) {
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
          return { body, status: upstream.status, statusText: upstream.statusText, headers: respHeaders }
        }

        return {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: respHeaders,
          body: upstream.body,
        }
      } catch (err) {
        clearTimeout(responseTimer)
        const timedOut = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
        if (timedOut) {
          logger.error('[proxy] upstream fetch timed out — opencode unresponsive', {
            path: input.path,
            timeoutMs: responseTimeoutMs,
          })
        } else {
          logger.error('[proxy] upstream fetch failed', err)
        }
        throw err
      }
    },
  }
}
