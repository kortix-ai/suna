import { emitJson, resolveProjectContext, surfaceApiError } from '../command-helpers.ts';
import { C, status } from '../style.ts';

interface TeamsInstallation {
  tenantId: string | null;
  catalogAppId: string | null;
  orgInstalled: boolean;
  /** Outcome of the one-click org-catalog publish; null for manual/BYO installs. */
  publishState?: 'publishing' | 'published' | 'review' | 'failed' | null;
  publishError?: string | null;
  /** The app version the org catalog serves; null when no publish recorded it. */
  appVersion?: string | null;
  latestAppVersion?: string;
  /** The catalog serves an older app than this server publishes. */
  appUpdateAvailable?: boolean;
  installedAt: string | null;
}

interface TeamsMode {
  /**
   * Always true on current servers: the `teams` feature flag graduated on
   * 2026-10-01. An older server reports its per-project flag here.
   */
  enabled: boolean;
  /** Server (or bring-your-own) bot credentials resolve ⇒ an install can run. */
  available: boolean;
  orgConsentUrl: string | null;
  orgInstalled: boolean;
  deepLinkUrl: string | null;
}

// ─── Microsoft Teams ─────────────────────────────────────────────────────
// The Teams backend is already mounted in the API (apps/api/src/channels/teams/,
// /v1/webhooks/teams/*, /v1/projects/:id/channels/teams/installation + /mode).
// These CLI functions mirror the Slack surface so an operator can connect a
// project to Teams the same way they connect to Slack.

export async function teamsStatus(
  ctxOpts: { projectArg?: string; hostArg?: string },
  json: boolean,
): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    const install = await ctx.client.get<TeamsInstallation | null>(
      `/projects/${ctx.projectId}/channels/teams/installation`,
    );
    if (json) {
      emitJson({ connected: Boolean(install), installation: install ?? null });
      return 0;
    }
    if (!install) {
      process.stdout.write(
        `${C.dim}teams${C.reset}  not connected\n` +
          `       Run ${C.cyan}kortix channels connect --platform teams${C.reset} — it prints the Microsoft admin-consent URL.\n`,
      );
      return 0;
    }
    // A bound tenant is a connection. The org-catalog publish is a SEPARATE
    // outcome that finishes in the background after consent, so report it on
    // its own line instead of folding it into "connected".
    process.stdout.write(
      `${status.ok('teams')}  tenant ${install.tenantId ?? '?'}${install.catalogAppId ? `  catalog app ${install.catalogAppId}` : ''}  (installed ${install.installedAt ?? '?'})\n`,
    );
    const publishLine = teamsPublishLine(install);
    if (publishLine) process.stdout.write(`       ${publishLine}\n`);
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

function teamsPublishLine(install: TeamsInstallation): string | null {
  const retry = `${C.cyan}kortix channels connect --platform teams${C.reset}`;
  // The server sets this only for a settled install in the org catalog,
  // including one published before Kortix recorded the publish state.
  if (install.appUpdateAvailable) {
    const served = install.appVersion ? `app ${install.appVersion}` : 'no recorded app version';
    return (
      `${C.yellow}Catalog: ${served}; ${install.latestAppVersion ?? 'a newer version'} is the latest${C.reset}\n` +
      `       A Teams admin re-runs ${retry} to publish it. Then a team owner updates the app in each team where Teams offers it.`
    );
  }
  switch (install.publishState) {
    case 'publishing':
      return `${C.dim}Catalog: publishing the app to the org Teams catalog… (re-run status in a minute)${C.reset}`;
    case 'review':
      return `${C.dim}Catalog: submitted for review — a Teams admin must approve the app in the Teams admin center${C.reset}`;
    case 'failed':
      return (
        `${status.err('Catalog publish failed')} ${install.publishError ?? 'no reason recorded'}\n` +
        `       Fix the cause, then re-run ${retry} to publish again.`
      );
    case 'published': {
      if (!install.orgInstalled) return null;
      const version = install.appVersion ? ` (app ${install.appVersion})` : '';
      return `${C.dim}Catalog: published to the org Teams catalog${version}${C.reset}`;
    }
    default:
      return install.orgInstalled
        ? null
        : `${C.dim}Catalog: app not published to the org catalog (manual upload, or re-run ${retry})${C.reset}`;
  }
}

export async function teamsConnect(
  ctxOpts: { projectArg?: string; hostArg?: string },
  opts: { json: boolean },
): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    const mode = await ctx.client.get<TeamsMode>(`/projects/${ctx.projectId}/channels/teams/mode`);
    // Only an older server (before the `teams` flag graduated) answers
    // `enabled: false`. Worded like that server's feature-flag gate. It is a
    // failure, so it goes to stderr like every other CLI error — stdout stays
    // reserved for the command's own output.
    if (!mode.enabled) {
      process.stderr.write(
        `${status.err('Microsoft Teams is not enabled for this project. Enable it in Settings → Feature flags.')}\n`,
      );
      return 1;
    }
    if (!mode.orgConsentUrl) {
      process.stdout.write(
        `${C.dim}Teams one-click install isn't configured on this host. Set MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD on the server, or bring your own bot from the dashboard.${C.reset}\n`,
      );
      return 1;
    }
    if (opts.json) {
      emitJson({ orgConsentUrl: mode.orgConsentUrl, orgInstalled: mode.orgInstalled });
      return 0;
    }
    process.stdout.write(
      `\n  ${C.bold}Add to Microsoft Teams — admin consent:${C.reset}\n\n` +
        `  ${mode.orgConsentUrl}\n\n` +
        `  Open the link, sign in as a Teams admin, grant tenant-wide consent.\n` +
        `  Kortix publishes the app to your Teams catalog automatically.\n` +
        `  Confirm after install with ${C.cyan}kortix channels status --platform teams${C.reset}.\n\n`,
    );
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

export async function teamsManifest(ctxOpts: {
  projectArg?: string;
  hostArg?: string;
}): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  // The Teams app manifest is BUILT by the API (apps/api/src/services/channels/teams-manifest.ts)
  // from the project's own app id and base URL. The checked-in
  // teams-app-manifest.json is a stale hand file and is not read at runtime.
  // Print it so an operator can review/submit it manually if the one-click flow
  // isn't available. The server's /mode endpoint carries the consent URL; the
  // manifest is static (doesn't depend on the project).
  const baseUrl = ctx.client.apiBase.replace(/\/$/, '');
  const manifestUrl = `${baseUrl}/v1/projects/${ctx.projectId}/channels/teams/mode`;
  try {
    const mode = await ctx.client.get<TeamsMode>(manifestUrl);
    process.stdout.write(
      JSON.stringify(
        {
          platform: 'teams',
          orgConsentUrl: mode.orgConsentUrl,
          orgInstalled: mode.orgInstalled,
          deepLinkUrl: mode.deepLinkUrl,
          note: 'The Teams app manifest is generated server-side by apps/api/src/services/channels/teams-manifest.ts. Use the orgConsentUrl above for one-click install; manual app-package upload uses buildTeamsAppPackage() in apps/api/src/services/channels/teams/app-package.ts.',
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ─── Microsoft Teams: disconnect ─────────────────────────────────────────
// DELETE /projects/:id/channels/teams/installation (channel-teams.ts). Needs the
// 'manage' project role + `project.connector.write`.

export async function teamsDisconnect(ctxOpts: {
  projectArg?: string;
  hostArg?: string;
}): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    await ctx.client.delete(`/projects/${ctx.projectId}/channels/teams/installation`);
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(
    `${status.ok('Disconnected')} ${C.dim}— the Teams install is removed from this project.${C.reset}\n`,
  );
  return 0;
}
