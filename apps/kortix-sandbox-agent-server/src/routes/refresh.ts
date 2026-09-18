import { Hono } from 'hono'

import { resolveOpencodeConfigDirRelative, type Config } from '../config'
import { refreshRepo, syncOpencodeConfigDirToBase, syncWorkspaceToBase } from '../git'
import { scheduleRuntimeAssetsReconcile } from '../runtime-assets'
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

/**
 * A refresh may kick a runtime-assets pass only once OpenCode is serving. The
 * API refreshes on session open, i.e. during a resume's boot; a pass then can
 * install a new OpenCode pin and restart it under the boot in progress
 * (Essentia 2026-08-25 17:23). main.ts runs the post-boot pass itself.
 */
export function refreshMayConvergeRuntime(opencodeState: string): boolean {
  return opencodeState === 'ok'
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
    // `?reload_if_synced=1` — reload opencode when, and only when, the config-dir
    // sync replaced files. opencode reads that directory at spawn. The API's env
    // push restarts it only when the env it carries changed, and a skill body, a
    // tool or a plugin is not in that env: measured on the #7403 preview, a
    // skill-only merge synced the files and left the same pid serving the old
    // skill list. The sync is the one place that knows files moved.
    //
    // A separate flag, not a new `restart` value: an older daemon reads any
    // `restart` other than '0' as "restart always", which would restart opencode
    // on every wake. An unknown flag is ignored, which is today's behaviour.
    const reloadIfSynced = c.req.query('reload_if_synced') === '1'
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
        // `reloadConfig`, not `reloadVerified`: a dispose re-reads the config dir
        // in place (~51 ms, no turn lost) and falls back to the verified restart
        // on its own when dispose is unavailable.
        const configDirReload =
          skipRestart && reloadIfSynced && configDir?.synced === true
            ? await opencode.reloadConfig()
            : null
        // Converge the sandbox's `kortix` CLI + managed-skill overlay on this
        // API. This route is what the platform already calls on warm reuse and
        // reload, and (since this change) after a restart and a resume — the
        // three moments a long-lived box comes back up without re-running its
        // image build. Detached on purpose: the route's callers await its
        // latency, and a ~100 MB download must never enter that budget. The
        // reconcile is single-flighted, so a burst of refreshes runs one pass.
        //
        // NEVER while OpenCode is still booting. The API calls this route from
        // the session-open path (env-sync) — on a resume that is BEFORE the
        // runtime is ready — and a pass that finds a stale pin installs the
        // new OpenCode and restarts it underneath the boot in progress
        // (Essentia 2026-08-25 17:23: install at +9 s, spawn at +13 s, the
        // API's start budget expired on both boxes). main.ts schedules the
        // post-boot pass itself once `opencode-ready` is marked; this call is
        // for a box that is already up.
        if (refreshMayConvergeRuntime(opencode.getState())) scheduleRuntimeAssetsReconcile(cfg)
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
          ...(configDirReload
            ? {
                config_dir_reload: {
                  how: configDirReload.how,
                  turn_ended: configDirReload.turnEnded,
                },
              }
            : {}),
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
