import { Hono } from 'hono'

import { resolveOpencodeConfigDirRelative, type Config } from '../config'
import { refreshRepo, syncOpencodeConfigDirToBase, syncWorkspaceToBase } from '../git'
import {
  KORTIX_SERVICE_CALL_HEADER,
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from '../kortix-user-context'
import { logger } from '../logger'
import type { Opencode } from '../opencode'

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export function createRefreshRouter(cfg: Config, opencode: Opencode): Hono {
  const router = new Hono()
  let refreshInFlight: Promise<Response> | null = null

  router.post('/', async (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }

    const serviceAuthenticated =
      bearerToken(c.req.header('Authorization')) === cfg.sandboxToken
    if (!serviceAuthenticated) {
      const auth = verifyKortixUserContext(
        c.req.header(KORTIX_USER_CONTEXT_HEADER),
        cfg.sandboxToken,
      )
      if (!auth.ok) {
        logger.warn('[refresh] reject', { reason: auth.reason })
        return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
      }
    }

    if (refreshInFlight) {
      return c.json({ error: 'refresh already running' }, 409)
    }

    // `?base=1` syncs a restored warm-snapshot workspace to the latest base tip;
    // `?restart=0` skips the opencode restart (the file watcher picks up changes
    // and keeps warm-snapshot restore fast). Default behaviour is refresh+restart.
    const syncBase = c.req.query('base') === '1'
    // `base=1` force-resets the session's own branch onto the base tip
    // (`syncWorkspaceToBase` → `git checkout -B <cfg.branchName> <sha>`, and
    // branchName IS the session id), discarding every commit the session made
    // and deleting the files they introduced.
    //
    // The API's own reload deliberately refuses to send it. But the endpoint is
    // reachable through the user-facing sandbox proxy — that proxy blocks
    // exactly one daemon path, `/kortix/env`, and this is not it — so any
    // principal who can see the session could wipe its history with one request,
    // as could the in-box agent via a prompt-injected `curl` against localhost.
    //
    // Its only legitimate caller is the warm-session workspace refresh, at
    // session CREATE, calling us DIRECTLY.
    //
    // The bearer alone cannot express that. The proxy authenticates everything
    // it relays — an ordinary user's request included — with this very sandbox's
    // service key, so `serviceAuthenticated` is true for user traffic too and a
    // bearer-only gate would be decoration. What the proxy does NOT relay is
    // KORTIX_SERVICE_CALL_HEADER: it strips it from every forwarded request, so
    // only a direct platform call can present it.
    //
    // Require BOTH. The header proves the hop, the bearer proves the caller, and
    // neither is sufficient alone: the header is unauthenticated on its own, and
    // the bearer is available to anything the proxy speaks to.
    if (syncBase && !(serviceAuthenticated && c.req.header(KORTIX_SERVICE_CALL_HEADER) === '1')) {
      logger.warn('[refresh] rejected base=1 from a non-service caller')
      return c.json(
        {
          error: 'base reset requires the sandbox service credential',
          code: 'BASE_RESET_FORBIDDEN',
        },
        403,
      )
    }
    const skipRestart = c.req.query('restart') === '0'
    // `?config_dir=1` updates ONLY the opencode config directory from the base
    // ref. Separate from `base=1` on purpose: that one resets the session's
    // BRANCH and discards its commits, which is fine at create-time on a warm
    // snapshot and catastrophic on a live session. This one touches a single
    // pathspec and refuses when the session has its own work there.
    //
    // An older daemon simply ignores this parameter and does the plain refresh,
    // which is the previous behaviour — so the API can send it unconditionally
    // without version negotiation.
    const syncConfigDir = c.req.query('config_dir') === '1'
    const baseSha = c.req.query('base_sha')
    if (baseSha !== undefined && !/^[0-9a-f]{40}$/i.test(baseSha)) {
      return c.json({ error: 'invalid base_sha' }, 400)
    }

    refreshInFlight = (async () => {
      try {
        const repo = syncBase
          ? await syncWorkspaceToBase(cfg, baseSha)
          : await refreshRepo(cfg)
        // After the repo op, so a successful pull is reflected before we compare
        // the config dir against base.
        const configDir = syncConfigDir
          ? await syncOpencodeConfigDirToBase(cfg, await resolveOpencodeConfigDirRelative(cfg), baseSha)
          : undefined
        // Verified swap, not a kill-then-hope restart: boot the new opencode,
        // prove it serves, and only then retire the running one. A config that
        // cannot boot leaves the session on the opencode it already had.
        // `?verify_fail=1` — fault injection for the reload's SAFETY path.
        //
        // The decline branch (candidate does not boot → keep the running
        // opencode, report why) cannot otherwise be reached on a real box: the
        // API validates agent configs against opencode's schema before they
        // reach a sandbox, so no supported input produces one that fails to
        // start. Without this the branch is provable only in unit tests.
        //
        // Safe to expose. Its entire effect is the reload DECLINING — the same
        // outcome the mechanism produces on a genuine failure. The session
        // keeps the opencode it already had, nothing is destroyed, and the
        // response says plainly that the config did not take.
        const reload = skipRestart
          ? null
          : await opencode.reloadVerified({ forceFail: c.req.query('verify_fail') === '1' })
        return c.json({
          // The repo work succeeded either way; `reload.outcome` carries whether
          // the new config actually took. Reporting ok:false here would hide a
          // successful pull behind a reload that safely declined to swap.
          ok: true,
          repo: {
            before: repo.before,
            after: repo.after,
          },
          ...(configDir ? { config_dir: configDir } : {}),
          ...(reload
            ? {
                reload: {
                  outcome: reload.outcome,
                  ...(reload.outcome === 'swapped'
                    ? {
                        port: reload.port,
                        pid: reload.pid,
                        // Whether the swap interrupted work someone was waiting
                        // on. null = could not tell; never report that as false.
                        turn_ended: reload.turnEnded,
                      }
                    : { reason: reload.reason }),
                },
              }
            : {}),
          opencode: opencode.getState(),
          opencode_pid: opencode.getPid(),
        })
      } catch (err) {
        const message = (err as Error).message || 'refresh failed'
        logger.error('[refresh] failed', err)
        const status = message.includes('not materialized') || message.includes('git pull refresh failed')
          ? 409
          : 500
        return c.json({ error: 'refresh failed', message }, status)
      } finally {
        refreshInFlight = null
      }
    })()

    return refreshInFlight
  })

  return router
}
