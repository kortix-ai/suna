/**
 * Staging's App hosts (`*.apps.kortix.com`) answer Cloudflare 530: the
 * apps-router Worker's `STAGING_API_ORIGIN` resolves to a dead tunnel, and the
 * API trusts `x-kortix-app-host` only when that edge signs it. The release gate
 * therefore cannot set `KE2E_CAP_APP_HOST`, and an App-host flow would skip and
 * fail `--require-all`. Lift this in the PR that points `STAGING_API_ORIGIN`
 * at a live origin and sets `KE2E_CAP_APP_HOST=1` in `tests-release.yml`. The
 * local lane still runs every one of these flows.
 */
export const stagingAppsEdgeQuarantine = (): { quarantine?: string } =>
  process.env.KE2E_TARGET === 'staging'
    ? {
        quarantine:
          'staging Apps edge: *.apps.kortix.com staging hosts return Cloudflare 530 (apps-router STAGING_API_ORIGIN resolves to a dead tunnel), so the gate cannot set KE2E_CAP_APP_HOST — quarantined 2026-10-09 until the apps-router staging origin is fixed',
      }
    : {};
