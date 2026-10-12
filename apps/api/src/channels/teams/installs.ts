import { chatInstalls, projectSecrets } from '@kortix/db';
import { and, eq, ne } from 'drizzle-orm';
import { getProjectSecretValuesForConsumer } from '../../projects/secrets';
import { db } from '../../shared/db';
import { TEAMS_MANIFEST_VERSION } from '../teams-manifest';
import { deleteProjectSecrets, readSecret, upsertSecret } from '../install-store';

export const MS_TEAMS_TENANT_ID = 'MS_TEAMS_TENANT_ID';
export const MS_TEAMS_SERVICE_URL = 'MS_TEAMS_SERVICE_URL';
export const MS_TEAMS_TEAM_ID = 'MS_TEAMS_TEAM_ID';
export const MS_TEAMS_TEAM_NAME = 'MS_TEAMS_TEAM_NAME';
export const MS_TEAMS_BOT_ID = 'MS_TEAMS_BOT_ID';
export const MS_TEAMS_APP_ID = 'MS_TEAMS_APP_ID';
export const MS_TEAMS_APP_PASSWORD = 'MS_TEAMS_APP_PASSWORD';
export const MS_TEAMS_ORG_INSTALLED = 'MS_TEAMS_ORG_INSTALLED';
export const MS_TEAMS_CATALOG_APP_ID = 'MS_TEAMS_CATALOG_APP_ID';
// Outcome of the one-click org-catalog publish (teams-oauth.ts), so the
// dashboard can show "publishing…", "pending review", or the Graph rejection
// instead of a redirect status nothing reads.
export const MS_TEAMS_PUBLISH_STATE = 'MS_TEAMS_PUBLISH_STATE';
export const MS_TEAMS_PUBLISH_ERROR = 'MS_TEAMS_PUBLISH_ERROR';
// The app manifest version the org catalog serves, read at each publish. A
// team on a version older than the read permissions refuses thread reads.
export const MS_TEAMS_APP_VERSION = 'MS_TEAMS_APP_VERSION';

const TEAMS_KEYS = [
  MS_TEAMS_TENANT_ID,
  MS_TEAMS_SERVICE_URL,
  MS_TEAMS_TEAM_ID,
  MS_TEAMS_TEAM_NAME,
  MS_TEAMS_BOT_ID,
  MS_TEAMS_APP_ID,
  MS_TEAMS_APP_PASSWORD,
  MS_TEAMS_ORG_INSTALLED,
  MS_TEAMS_CATALOG_APP_ID,
  MS_TEAMS_PUBLISH_STATE,
  MS_TEAMS_PUBLISH_ERROR,
  MS_TEAMS_APP_VERSION,
] as const;

export type TeamsPublishState = 'publishing' | 'published' | 'review' | 'failed';

const TEAMS_PUBLISH_STATES: ReadonlySet<string> = new Set(['publishing', 'published', 'review', 'failed']);

function parsePublishState(value: string | undefined): TeamsPublishState | null {
  return value && TEAMS_PUBLISH_STATES.has(value) ? (value as TeamsPublishState) : null;
}

export interface TeamsInstallSummary {
  tenantId: string;
  teamId: string | null;
  teamName: string | null;
  botId: string | null;
  serviceUrl: string | null;
  byo: boolean;
  orgInstalled: boolean;
  catalogAppId: string | null;
  /** Null until a one-click install has run (manual + BYO installs never publish). */
  publishState: TeamsPublishState | null;
  /** The Graph rejection when `publishState === 'failed'`; null otherwise. */
  publishError: string | null;
  /** The app version the org catalog serves; null when no publish recorded it. */
  appVersion: string | null;
  /** The app version this deployment publishes. */
  latestAppVersion: string;
  /**
   * A one-click install whose catalog serves an older app, or one published
   * before Kortix recorded the version. Publishing again sends the latest.
   */
  appUpdateAvailable: boolean;
  installedAt: string;
}

export interface TeamsInstallInput {
  projectId: string;
  tenantId: string;
  teamId?: string | null;
  teamName?: string | null;
  botId?: string | null;
  serviceUrl?: string | null;
  appId?: string | null;
  appPassword?: string | null;
}

interface TeamsBotCredentials {
  appId: string;
  appPassword: string;
}

export async function saveTeamsInstall(input: TeamsInstallInput): Promise<TeamsInstallSummary> {
  const { projectId, tenantId } = input;
  // One tenant per project (MS_TEAMS_TENANT_ID is single-valued). A reconnect
  // to another tenant retires the old tenant's row, so the install record the
  // inbound routes and the file proxy trust names only the tenant proven last.
  await db
    .delete(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, 'teams'),
        eq(chatInstalls.projectId, projectId),
        ne(chatInstalls.workspaceId, tenantId),
      ),
    );
  await db
    .insert(chatInstalls)
    .values({ platform: 'teams', workspaceId: tenantId, projectId })
    .onConflictDoNothing();

  await upsertSecret(projectId, MS_TEAMS_TENANT_ID, tenantId);
  if (input.teamId != null) await upsertSecret(projectId, MS_TEAMS_TEAM_ID, input.teamId);
  if (input.teamName != null) await upsertSecret(projectId, MS_TEAMS_TEAM_NAME, input.teamName);
  if (input.botId != null) await upsertSecret(projectId, MS_TEAMS_BOT_ID, input.botId);
  if (input.serviceUrl != null) await upsertSecret(projectId, MS_TEAMS_SERVICE_URL, input.serviceUrl);
  if (input.appId != null) await upsertSecret(projectId, MS_TEAMS_APP_ID, input.appId);
  if (input.appPassword != null) await upsertSecret(projectId, MS_TEAMS_APP_PASSWORD, input.appPassword);

  return {
    tenantId,
    teamId: input.teamId ?? null,
    teamName: input.teamName ?? null,
    botId: input.botId ?? null,
    serviceUrl: input.serviceUrl ?? null,
    byo: Boolean(input.appId),
    orgInstalled: false,
    catalogAppId: null,
    publishState: null,
    publishError: null,
    appVersion: null,
    latestAppVersion: TEAMS_MANIFEST_VERSION,
    appUpdateAvailable: false,
    installedAt: new Date().toISOString(),
  };
}

export async function setTeamsPublishState(
  projectId: string,
  state: TeamsPublishState,
  error?: string | null,
): Promise<void> {
  await upsertSecret(projectId, MS_TEAMS_PUBLISH_STATE, state);
  await upsertSecret(projectId, MS_TEAMS_PUBLISH_ERROR, state === 'failed' ? (error ?? '').slice(0, 500) : '');
}

export async function setTeamsOrgInstalled(projectId: string, installed: boolean): Promise<void> {
  await upsertSecret(projectId, MS_TEAMS_ORG_INSTALLED, installed ? '1' : '');
}

export async function setTeamsCatalogAppId(projectId: string, catalogAppId: string): Promise<void> {
  await upsertSecret(projectId, MS_TEAMS_CATALOG_APP_ID, catalogAppId);
}

export async function setTeamsAppVersion(projectId: string, version: string): Promise<void> {
  await upsertSecret(projectId, MS_TEAMS_APP_VERSION, version);
}

export async function loadTeamsBotCredentials(projectId: string): Promise<TeamsBotCredentials | null> {
  const secrets = await readTeamsSecrets(projectId);
  const appId = secrets[MS_TEAMS_APP_ID];
  const appPassword = secrets[MS_TEAMS_APP_PASSWORD];
  if (!appId || !appPassword) return null;
  return { appId, appPassword };
}

export async function loadTeamsAppIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, MS_TEAMS_APP_ID);
}

/** Update just the conversation serviceUrl — refreshed from each inbound activity. */
export async function saveTeamsServiceUrl(projectId: string, serviceUrl: string): Promise<void> {
  if (!serviceUrl) return;
  await upsertSecret(projectId, MS_TEAMS_SERVICE_URL, serviceUrl);
}

export async function loadTeamsInstall(projectId: string): Promise<TeamsInstallSummary | null> {
  const secrets = await readTeamsSecrets(projectId);
  const tenantId = secrets[MS_TEAMS_TENANT_ID];
  if (!tenantId) return null;
  const [row] = await db
    .select({ updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, MS_TEAMS_TENANT_ID)))
    .limit(1);
  const byo = Boolean(secrets[MS_TEAMS_APP_ID]);
  const orgInstalled = Boolean(secrets[MS_TEAMS_ORG_INSTALLED]);
  const publishState = parsePublishState(secrets[MS_TEAMS_PUBLISH_STATE]);
  const appVersion = secrets[MS_TEAMS_APP_VERSION] || null;
  // In the org catalog and settled. A null state is an install published
  // before Kortix recorded it; publishing, review and failed say what to do.
  const catalogSettled = orgInstalled && !byo && (publishState === null || publishState === 'published');
  return {
    tenantId,
    teamId: secrets[MS_TEAMS_TEAM_ID] || null,
    teamName: secrets[MS_TEAMS_TEAM_NAME] || null,
    botId: secrets[MS_TEAMS_BOT_ID] || null,
    serviceUrl: secrets[MS_TEAMS_SERVICE_URL] || null,
    byo,
    orgInstalled,
    catalogAppId: secrets[MS_TEAMS_CATALOG_APP_ID] || null,
    publishState,
    publishError: secrets[MS_TEAMS_PUBLISH_ERROR] || null,
    appVersion,
    latestAppVersion: TEAMS_MANIFEST_VERSION,
    appUpdateAvailable: catalogSettled && isOlderAppVersion(appVersion),
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

/** Null is older: the install was published before Kortix recorded the version. */
function isOlderAppVersion(version: string | null): boolean {
  return version === null || version.localeCompare(TEAMS_MANIFEST_VERSION, 'en', { numeric: true }) < 0;
}

/**
 * The tenant the project's Teams install proved, from `chat_installs`.
 *
 * Not the `MS_TEAMS_TENANT_ID` secret: this tenant selects whose Microsoft
 * Graph data the connector reads, with the managed app every customer shares.
 * A secret a project writer could overwrite would let one customer's project
 * name another customer's tenant (found in the 2026-09-29 permissions audit).
 */
export async function loadTeamsTenantForProject(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'teams'), eq(chatInstalls.projectId, projectId)))
    .limit(1);
  return row?.workspaceId || null;
}

export async function loadTeamsServiceUrlForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, MS_TEAMS_SERVICE_URL);
}

export async function deleteTeamsInstall(projectId: string): Promise<void> {
  await deleteProjectSecrets(projectId, TEAMS_KEYS);
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'teams'), eq(chatInstalls.projectId, projectId)));
}

// One query for all Teams names. The connector sync calls this for every
// project, nearly all uninstalled, so it is a probe: absent names write no audit row.
async function readTeamsSecrets(projectId: string): Promise<Record<string, string>> {
  return getProjectSecretValuesForConsumer({
    projectId,
    names: [...TEAMS_KEYS],
    consumer: 'connector',
  });
}
