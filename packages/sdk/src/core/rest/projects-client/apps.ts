// Kortix Apps — project-scoped, provider-neutral applications. Every App has
// one `kind`; clients branch on its `capabilities`, never on the kind.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type AppHostingProvider = 'daytona' | 'platinum' | 'e2b';
export type AppDesiredState = 'running' | 'stopped';
export type AppAccessMode = 'private' | 'project' | 'restricted' | 'public' | 'password';
export type AppArtifactKind = 'archive' | 'oci_image';
export type AppArtifactStatus = 'uploading' | 'uploaded' | 'ready' | 'rejected' | 'deleted';
/** `convex`: a deployment of a `convex` App, recorded after the client CLI deployed it. */
export type AppSourceKind = 'static' | 'bundle' | 'dockerfile' | 'oci_image' | 'convex';

/**
 * What an App is, fixed at create. `web`: a site or a server built from its
 * deployments. `convex`: a self-hosted Convex backend in its own always-on
 * machine. Branch on `capabilities`, not on the kind.
 */
export type AppKind = 'web' | 'convex';

/**
 * What an App supports now. The only thing a client branches on. A route
 * for a capability the App lacks answers `409 app_capability_unsupported`.
 *
 * - `deployments`: has a deployment history.
 * - `rollback`: traffic can move to an older ready deployment.
 * - `preview`: opens in a browser through an access session.
 * - `sleep`: a server that stops when idle (`start` / `stop`).
 * - `static`: served from storage, no runtime.
 * - `snapshots`, `restore`: point-in-time copies of its data, and a rollback to one.
 * - `admin_credentials`: an admin key for the kind's own CLI ({@link getAppCredentials}).
 * - `dashboard`: an admin dashboard (`instance.dashboard_url`).
 * - `logs`: a process log ({@link getAppLog}).
 * - `member_tokens`: Kortix sign-in tokens for the App ({@link createAppToken}).
 */
export type AppCapability =
  | 'deployments'
  | 'rollback'
  | 'preview'
  | 'sleep'
  | 'static'
  | 'snapshots'
  | 'restore'
  | 'admin_credentials'
  | 'dashboard'
  | 'logs'
  | 'member_tokens';

/**
 * The public values that verify the Kortix sign-in tokens minted for an App:
 * the project issuer, `aud` = the App id, and the issuer's key set. No secret.
 */
export interface AppAuth {
  issuer: string;
  audience: string;
  jwks_uri: string;
}

export type AppInstanceStatus = 'provisioning' | 'running' | 'error' | 'deleted';

/**
 * A day-two operation in flight on the App's machine. `rotating_key`: an
 * admin-credentials rotation. `recovering`: Kortix is starting the machine, or
 * restoring it from its last automatic backup. `snapshotting`: a snapshot is
 * taken or deleted. `restoring`: a snapshot restore.
 */
export type AppInstanceOperation = 'resizing' | 'rotating_key' | 'recovering' | 'snapshotting' | 'restoring';

/** The last health probe of a running instance. Kortix probes every 5 minutes. */
export interface AppInstanceHealth {
  ok: boolean;
  checked_at: string;
  /** The machine's state: `running`, `stopped`, …; `missing` when it no longer exists; `null` when the provider did not answer. */
  machine_state: string | null;
  /** Failed probes in a row. */
  failures: number;
  error: string | null;
  /** Percent of the machine disk in use, when known. */
  disk_used_pct: number | null;
  /** What the probe started to bring the machine back, if anything. */
  repair: 'started' | 'restored_from_backup' | null;
}

/**
 * The machine of an App whose kind runs one of its own (`convex`). `null` on
 * every other App. Read `capabilities` to know which fields apply.
 */
export interface AppInstance {
  status: AppInstanceStatus;
  /** The client URL (the App's `url`): a Kortix host fixed for the App's life. `null` until it runs. */
  url: string | null;
  /** The HTTP actions URL, a second Kortix host. `null` until it runs. */
  site_url: string | null;
  /** The admin dashboard on a Kortix host (capability `dashboard`). `null` until it runs. */
  dashboard_url: string | null;
  error: string | null;
  /** A day-two operation in flight. `null` when idle. */
  operation: AppInstanceOperation | null;
  /** Why the last operation failed. Cleared by the next operation. */
  last_operation_error: string | null;
  /** The last health probe; `null` before the first one. */
  health: AppInstanceHealth | null;
  /**
   * `KORTIX_AUTH_ISSUER`, `KORTIX_AUTH_AUDIENCE` and `KORTIX_AUTH_JWKS` as the
   * machine's environment holds them: public values. `null` before the
   * project's first sign-in token.
   */
  auth_env: Record<string, string> | null;
  /** The client CLI version that matches the machine, e.g. `npx convex@<version> deploy`. */
  client_version: string;
  /**
   * Always `null`: a `convex` App has no monthly budget (its cost is its size,
   * 24/7), so no alert is raised. Kept for wire compatibility.
   * @deprecated Read `App.estimated_monthly_usd` for the monthly cost.
   */
  budget_alert: {
    month: string;
    percent: number;
    spent_usd: number;
    budget_usd: number;
    at: string;
  } | null;
  /** On a deleted App: when Kortix purges the kept machine and its final snapshot. */
  purge_after: string | null;
}
export type AppDeploymentStatus =
  | 'queued'
  | 'validating'
  | 'building'
  | 'provisioning'
  | 'checking'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface AppMachineSpec {
  cpu: number;
  memory_gb: number;
  disk_gb: number;
}

export interface App {
  app_id: string;
  account_id: string;
  project_id: string;
  /** Optional for wire compatibility with a server that predates kinds (read it as `web`). */
  kind?: AppKind;
  /** What the App supports now. Optional for wire compatibility with a server that predates it. */
  capabilities?: AppCapability[];
  slug: string;
  name: string;
  url: string;
  access_mode: AppAccessMode;
  access_revision: number;
  desired_state: AppDesiredState;
  active_deployment_id: string | null;
  machine: AppMachineSpec;
  idle_timeout_seconds: number;
  /**
   * `true`: the App runs 24/7 (cron jobs, workers, websockets keep working)
   * at a fixed monthly cost, `estimated_monthly_usd`. `false`: it stops after
   * `idle_timeout_seconds` without requests and wakes on the next one. `false`
   * for a static App, which has no runtime. Optional for wire compatibility
   * with a server that predates it.
   */
  always_on?: boolean;
  /**
   * The monthly compute budget of an on-demand server App (`always_on: false`):
   * the App stops when it is reached. `null` for an always-on, static or
   * `convex` App: its cost is fixed by its size (`estimated_monthly_usd`) or
   * zero, and no budget stops it. Setting one on such an App answers
   * `400 app_budget_not_applicable`.
   */
  monthly_budget_usd: number | null;
  /**
   * What the App's machine costs running 24/7 for one month at list compute
   * rates (USD): the monthly cost of an always-on or `convex` App, the most an
   * on-demand one can cost. `0` for a static App, which runs no machine.
   * Optional for wire compatibility with a server that predates it.
   */
  estimated_monthly_usd?: number;
  /**
   * How the active deployment is hosted. `static`: served from storage, with
   * no runtime: it serves whatever `desired_state` says, and start/stop
   * answer `409 static_app_no_runtime`. `sandbox`: a server App. `null`: not
   * deployed yet. `convex`: the App's own machine. Optional for wire
   * compatibility with a server that predates it.
   */
  hosting_type?: 'sandbox' | 'static' | 'convex' | null;
  /**
   * Ready deployments the App keeps besides its active one, as rollback
   * targets. Older ones are retired. Optional for wire compatibility.
   */
  retained_deployments?: number;
  /**
   * Set on the create and update responses only. Empty today: the
   * `app_budget_below_always_on` warning is gone, because an always-on App
   * has no budget.
   */
  warnings?: Array<{ code: string; message: string }>;
  last_request_at: string | null;
  /**
   * May the caller OPEN this App? `listApps` returns only Apps the caller
   * may open (a project manager: every App), so a listed App reads `true`;
   * an App left out answers 404 on `getApp`.
   *
   * Optional for wire compatibility with a server that predates the field.
   * Treat `undefined` as "unknown", not as "denied".
   */
  viewer_can_access?: boolean;
  /**
   * The Apps, by slug, this App uses. Its code may mint their sign-in tokens
   * (`kortixToken({ audience })`) and reach them through the bindings mount
   * (`kortixBinding(slug)`). Any other App answers `403 app_not_linked`.
   * Optional for wire compatibility with a server that predates it.
   */
  uses?: string[];
  /** The Apps, by slug, that use this App. Optional for wire compatibility. */
  used_by?: string[];
  /** Verifies the sign-in tokens minted for this App. Optional for wire compatibility. */
  auth?: AppAuth;
  /** The App's own machine (kind `convex`); `null` for every other App. Optional for wire compatibility. */
  instance?: AppInstance | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAppInput {
  slug: string;
  name: string;
  /** Fixed for the App's life. Default `web`. */
  kind?: AppKind;
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
  idle_timeout_seconds?: number;
  /** Run 24/7. Defaults to the server's setting (Kortix Cloud: `true`). */
  always_on?: boolean;
  /** On-demand server Apps only (default `5`); `400 app_budget_not_applicable` for an always-on or `convex` App. */
  monthly_budget_usd?: number;
  /** The Apps, by slug, this App uses. Each must exist. Default: none. */
  uses?: string[];
}

export interface UpdateAppInput {
  name?: string;
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
  idle_timeout_seconds?: number;
  /** `false` sets the budget to `monthly_budget_usd` or `5`; `true` clears it (`null`). */
  always_on?: boolean;
  /** On-demand server Apps only; `400 app_budget_not_applicable` for an always-on, static or `convex` App. */
  monthly_budget_usd?: number;
  /** Replaces the Apps this App uses. `[]` removes every link. */
  uses?: string[];
}

/**
 * What the Apps gate tells a Kortix-hosted App about the person looking at it.
 * `identity` (the default) signs the viewer's id, email and groups into every
 * request; `api` adds a token that acts AS the viewer on the Kortix API;
 * `off` shares nothing. See `kortixAppViewerToken` / `readAppViewer`.
 */
export type AppViewerTokenScope = 'off' | 'identity' | 'api';

export interface AppAccessConfig {
  mode: AppAccessMode;
  revision: number;
  member_ids: string[];
  group_ids: string[];
  password_configured: boolean;
  viewer_token_scope: AppViewerTokenScope;
}

export interface UpdateAppAccessInput {
  mode: AppAccessMode;
  member_ids?: string[];
  group_ids?: string[];
  password?: string;
  viewer_token_scope?: AppViewerTokenScope;
}

export interface AppAccessSession {
  url: string;
  expires_at: string;
}

export interface AppArtifact {
  artifact_id: string;
  project_id: string;
  kind: AppArtifactKind;
  status: AppArtifactStatus;
  image_reference: string | null;
  sha256: string | null;
  size_bytes: number | null;
  media_type: string | null;
  error: string | null;
  created_at: string;
}

export type RegisterAppArtifactInput =
  | { kind: 'archive'; media_type?: string }
  | { kind: 'oci_image'; image: string };

export interface RegisterAppArtifactResponse {
  artifact: AppArtifact;
  upload: { url: string; max_bytes: number } | null;
}

export interface FinalizeAppArtifactInput {
  sha256: string;
  size_bytes: number;
}

interface BaseAppSource {
  readiness_path?: string;
}

export interface StaticAppSource extends BaseAppSource {
  kind: 'static';
  root?: string;
  spa?: boolean;
}

export interface BundleAppSource extends BaseAppSource {
  kind: 'bundle';
  install_command?: string;
  build_command?: string;
  output_dir?: string;
  spa?: boolean;
}

export interface DockerfileAppSource extends BaseAppSource {
  kind: 'dockerfile';
  dockerfile?: string;
  command: string[];
  port: number;
  restart_limit?: number;
}

export interface OciImageAppSource extends BaseAppSource {
  kind: 'oci_image';
  image: string;
  command: string[];
  port: number;
  restart_limit?: number;
}

export type AppSource =
  | StaticAppSource
  | BundleAppSource
  | DockerfileAppSource
  | OciImageAppSource;

/**
 * A build of an uploaded artifact (`web`), or, for an App whose kind deploys
 * with its own client CLI (`convex`), a record of what that CLI deployed:
 * `{ source: { kind: 'convex', revision } }` with no artifact.
 */
export type CreateAppDeploymentInput = CreateAppBuildInput | { source: { kind: 'convex'; revision?: string } };

export interface CreateAppBuildInput {
  artifact_id: string;
  source: AppSource;
  /** Optional infrastructure preference. Omit it to use the server policy. */
  provider?: AppHostingProvider;
  /** Non-secret runtime environment values. */
  environment?: Record<string, string>;
  /** Runtime environment key -> project secret identifier. */
  secrets?: Record<string, string>;
}

export interface AppDeployment {
  deployment_id: string;
  app_id: string;
  /** `null` for a deployment recorded without an artifact (kind `convex`). */
  artifact_id: string | null;
  version: number;
  status: AppDeploymentStatus;
  source_kind: AppSourceKind;
  /** `static`: served from storage, no runtime. `sandbox`: runs in its own machine. `convex`: the App's own machine. */
  hosting_type: 'sandbox' | 'static' | 'convex';
  hosting_provider: AppHostingProvider | null;
  runtime_spec: Record<string, unknown>;
  build_spec: Record<string, unknown>;
  error_code: string | null;
  error: string | null;
  attempt_count: number;
  started_at: string | null;
  ready_at: string | null;
  failed_at: string | null;
  /** User whose deployment request resolved personal project-secret overrides. */
  created_by: string;
  /** Originating Kortix project session when an agent created this deployment. */
  source_session_id: string | null;
  /** Immutable caller class recorded when the deployment was created. */
  actor_type: 'human' | 'agent' | 'service_account' | 'system';
  created_at: string;
  updated_at: string;
}

export interface AppDeploymentEvent {
  event_id: string;
  runtime_id: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  type: string;
  message: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface AppDeploymentDetail {
  deployment: AppDeployment;
  events: AppDeploymentEvent[];
}

export interface AppLogEntry {
  cursor: number;
  time: string;
  source: 'app' | 'appd' | 'caddy' | string;
  line: string;
}

export interface AppLogsResponse {
  entries: AppLogEntry[];
  next_cursor: number;
}

export interface AppLogsOptions {
  after?: number;
  limit?: number;
}

/** The project's Apps the caller may open (a project manager: every App). */
export async function listApps(projectId: string): Promise<App[]> {
  const data = unwrap(
    await backendApi.get<{ apps: App[] }>(`/projects/${projectId}/apps`),
    'Failed to list Apps',
  );
  return data.apps;
}

export async function createApp(projectId: string, input: CreateAppInput): Promise<App> {
  return unwrap(
    await backendApi.post<App>(`/projects/${projectId}/apps`, input),
    'Failed to create App',
  );
}

export async function getApp(projectId: string, appId: string): Promise<App> {
  return unwrap(
    await backendApi.get<App>(`/projects/${projectId}/apps/${appId}`),
    'Failed to load App',
  );
}

export async function updateApp(
  projectId: string,
  appId: string,
  input: UpdateAppInput,
): Promise<App> {
  return unwrap(
    await backendApi.patch<App>(`/projects/${projectId}/apps/${appId}`, input),
    'Failed to update App',
  );
}

/**
 * Provider images a delete freed. Each deployment build leaves one image, and
 * providers cap how many an organization may hold. `pending` images were not
 * released yet (a stopping sandbox still pins one, or the provider call
 * failed); the platform retries them.
 */
export interface AppImageRelease {
  released: number;
  pending: number;
}

export interface DeleteAppOptions {
  /**
   * The App's slug, typed by the person deleting it. An App with
   * `snapshots` holds data: without it the delete answers
   * `400 confirmation_required`.
   */
  confirm?: string;
}

export interface DeleteAppResult {
  ok: boolean;
  images?: AppImageRelease;
  /** An App with `snapshots`: Kortix keeps the stopped machine and a `final` snapshot until then. */
  retained_until?: string | null;
  final_snapshot_id?: string | null;
}

/**
 * Deletes the App, its runtimes, and every deployment image it built. An App
 * with `snapshots` needs `confirm` (its slug) and project.app.admin; Kortix
 * keeps its stopped machine and a `final` snapshot 7 days.
 */
export async function deleteApp(
  projectId: string,
  appId: string,
  options: DeleteAppOptions = {},
): Promise<DeleteAppResult> {
  const query = options.confirm === undefined ? '' : `?confirm=${encodeURIComponent(options.confirm)}`;
  return unwrap(
    await backendApi.delete<DeleteAppResult>(`/projects/${projectId}/apps/${appId}${query}`),
    'Failed to delete App',
  );
}

export interface WaitForAppOptions {
  /** Default 15 minutes: the API's own provisioning deadline. */
  timeoutMs?: number;
  /** Default 1 second. */
  intervalMs?: number;
}

/**
 * Polls an App until its instance runs with no operation in flight (after a
 * create, resize, restore or credentials rotation). Resolves at once for an
 * App without an instance. Rejects with the instance's error, with an
 * operation error that appeared during the wait, and after `timeoutMs`.
 */
export async function waitForApp(projectId: string, appId: string, options: WaitForAppOptions = {}): Promise<App> {
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  let before: string | null | undefined;
  for (;;) {
    const app = await getApp(projectId, appId);
    const instance = app.instance;
    if (!instance) return app;
    if (before === undefined) before = instance.last_operation_error;
    if (instance.status === 'error' || instance.status === 'deleted') {
      throw new Error(instance.error ?? `App ${app.slug} is ${instance.status}`);
    }
    if (instance.status === 'running' && !instance.operation) {
      if (instance.last_operation_error && instance.last_operation_error !== before) {
        throw new Error(instance.last_operation_error);
      }
      return app;
    }
    if (Date.now() >= deadline) {
      throw new Error(`App ${app.slug} is still ${instance.operation ?? instance.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
  }
}

// ── Capability routes ────────────────────────────────────────────────────────

/**
 * Who made a snapshot, which decides how long it stays. `manual`: kept until
 * deleted. `automatic`: the daily snapshot, kept 7 days. `resize`: taken
 * before a resize, kept 24 hours. `final`: taken when the App was deleted,
 * kept 7 days.
 */
export type AppSnapshotKind = 'manual' | 'automatic' | 'resize' | 'final';

export interface AppSnapshot {
  snapshot_id: string;
  created_at: string;
  size_bytes: number | null;
  kind: AppSnapshotKind;
  /** When Kortix deletes it; `null` for a manual one. */
  expires_at: string | null;
}

/** Capability `snapshots`: the snapshots, the automatic backup and the schedule. */
export interface AppSnapshots {
  /** The machine-level backup Kortix restores on its own after a host loss. Not selectable. */
  automatic: {
    state: string | null;
    last_backup_at: string | null;
    size_bytes: number | null;
    interval_minutes: number | null;
  };
  /** Newest first. */
  snapshots: AppSnapshot[];
  /** Manual snapshots an App holds. At the limit a new one answers `409 snapshot_limit`. */
  snapshot_limit: number;
  snapshot_schedule: {
    automatic_interval_hours: number;
    automatic_retention_days: number;
    resize_retention_hours: number;
    /** The last automatic snapshot; `null` before the first. */
    last_automatic_at: string | null;
  };
}

/** Capability `snapshots`. */
export async function listAppSnapshots(projectId: string, appId: string): Promise<AppSnapshots> {
  return unwrap(
    await backendApi.get<AppSnapshots>(`/projects/${projectId}/apps/${appId}/snapshots`),
    'Failed to list App snapshots',
  );
}

/**
 * Capability `snapshots`. Takes a manual snapshot, kept until deleted. The
 * machine pauses for the copy (seconds). Answers `409` with `snapshot_limit`
 * or `app_busy`.
 */
export async function createAppSnapshot(projectId: string, appId: string): Promise<AppSnapshot> {
  return unwrap(
    await backendApi.post<AppSnapshot>(`/projects/${projectId}/apps/${appId}/snapshots`, {}),
    'Failed to take an App snapshot',
  );
}

/** Capability `snapshots`. Deletes one snapshot of any kind. This cannot be undone. */
export async function deleteAppSnapshot(projectId: string, appId: string, snapshotId: string): Promise<void> {
  const response = await backendApi.delete(
    `/projects/${projectId}/apps/${appId}/snapshots/${encodeURIComponent(snapshotId)}`,
  );
  if (!response.success) throw response.error ?? new Error('Failed to delete the App snapshot');
}

/**
 * Capability `restore`. Rolls the App back to a snapshot: every change after
 * it is lost. Resolves once the machine runs the snapshot. Answers `409` with
 * `snapshot_predates_resize` or `app_busy`.
 */
export async function restoreAppSnapshot(projectId: string, appId: string, snapshotId: string): Promise<App> {
  return unwrap(
    await backendApi.post<App>(`/projects/${projectId}/apps/${appId}/restore`, { snapshot_id: snapshotId }),
    'Failed to restore the App',
  );
}

/** Capability `admin_credentials`. Every read is audited. */
export interface AppCredentials {
  url: string;
  site_url: string;
  /** Controls the App's code and data. Keep it out of files you commit. */
  admin_key: string;
  /** Ready-to-use variables for the kind's client CLI against this App. */
  env: Record<string, string>;
}

/** Capability `admin_credentials`. Answers `409 app_not_running` until the App runs. */
export async function getAppCredentials(projectId: string, appId: string): Promise<AppCredentials> {
  return unwrap(
    await backendApi.get<AppCredentials>(`/projects/${projectId}/apps/${appId}/credentials`),
    'Failed to read the App credentials',
  );
}

/**
 * Capability `admin_credentials`. Replaces the admin key: every key read
 * before stops working. The machine restarts (about 1 s). Read the new key
 * with {@link getAppCredentials}.
 */
export async function rotateAppCredentials(projectId: string, appId: string): Promise<App> {
  return unwrap(
    await backendApi.post<App>(`/projects/${projectId}/apps/${appId}/rotate-credentials`, {}),
    'Failed to rotate the App credentials',
  );
}

export interface AppToken {
  /** ES256 JWT from the project issuer, `aud` = the App id. Verify it with the App's `auth` values. */
  token: string;
  expires_at: string;
}

/**
 * Capability `member_tokens`. A 15-minute Kortix sign-in token for the App,
 * naming the caller. In an agent session it names the agent.
 */
export async function createAppToken(projectId: string, appId: string): Promise<AppToken> {
  return unwrap(
    await backendApi.post<AppToken>(`/projects/${projectId}/apps/${appId}/token`, {}),
    'Failed to mint an App token',
  );
}

export interface GetAppLogOptions {
  /** 1 to 1000. Default 200. */
  lines?: number;
}

/** Capability `logs`. The last lines of the App's process log, newest last. */
export async function getAppLog(projectId: string, appId: string, options: GetAppLogOptions = {}): Promise<string> {
  return unwrap(
    await backendApi.get<{ log: string }>(`/projects/${projectId}/apps/${appId}/logs?lines=${options.lines ?? 200}`),
    'Failed to read the App log',
  ).log;
}

export async function getAppAccess(projectId: string, appId: string): Promise<AppAccessConfig> {
  return unwrap(
    await backendApi.get<AppAccessConfig>(`/projects/${projectId}/apps/${appId}/access`),
    'Failed to load App access policy',
  );
}

/**
 * One agent whose `kortix.yaml` grant `agents.<name>.apps` names an App.
 * `grant` is `all` when the agent lists `apps: all`, `listed` when it names the
 * App's slug. Read-only: the manifest is the source of truth, so an agent's App
 * access changes through a change to `kortix.yaml`, never through this API.
 */
export interface AppAgentAccess {
  agent_name: string;
  grant: 'all' | 'listed';
  /** Where the grant is declared, e.g. `kortix.yaml#agents.report-writer`. */
  path: string;
}

/** The agents whose `apps:` grant names this App (or is `all`). */
export async function listAppAgents(projectId: string, appId: string): Promise<AppAgentAccess[]> {
  return unwrap(
    await backendApi.get<{ agents: AppAgentAccess[] }>(`/projects/${projectId}/apps/${appId}/agents`),
    'Failed to load the agents with access to this App',
  ).agents;
}

export async function updateAppAccess(
  projectId: string,
  appId: string,
  input: UpdateAppAccessInput,
): Promise<AppAccessConfig> {
  return unwrap(
    await backendApi.patch<AppAccessConfig>(`/projects/${projectId}/apps/${appId}/access`, input),
    'Failed to update App access policy',
  );
}

export async function createAppAccessSession(projectId: string, appId: string): Promise<AppAccessSession> {
  return unwrap(
    await backendApi.post<AppAccessSession>(`/projects/${projectId}/apps/${appId}/access-session`, {}),
    'Failed to create App access session',
  );
}

export async function registerAppArtifact(
  projectId: string,
  input: RegisterAppArtifactInput,
): Promise<RegisterAppArtifactResponse> {
  return unwrap(
    await backendApi.post<RegisterAppArtifactResponse>(`/projects/${projectId}/apps/artifacts`, input),
    'Failed to register App artifact',
  );
}

export async function finalizeAppArtifact(
  projectId: string,
  artifactId: string,
  input: FinalizeAppArtifactInput,
): Promise<AppArtifact> {
  return unwrap(
    await backendApi.post<AppArtifact>(
      `/projects/${projectId}/apps/artifacts/${artifactId}/finalize`,
      input,
    ),
    'Failed to finalize App artifact',
  );
}

export interface UploadAppArtifactOptions {
  mediaType?: string;
  signal?: AbortSignal;
  /** Reports confirmed upload states: zero before fetch and total after HTTP success. */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

async function archiveBytes(input: Blob | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(await input.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Register, upload, hash, and finalize one immutable `.tar.gz` artifact. */
export async function uploadAppArtifactArchive(
  projectId: string,
  input: Blob | Uint8Array,
  options: UploadAppArtifactOptions = {},
): Promise<AppArtifact> {
  const bytes = await archiveBytes(input);
  const mediaType = options.mediaType ?? 'application/gzip';
  const registered = await registerAppArtifact(projectId, { kind: 'archive', media_type: mediaType });
  if (!registered.upload) throw new Error('App artifact registration did not return an upload URL');
  if (bytes.byteLength > registered.upload.max_bytes) {
    throw new Error(`App artifact exceeds ${registered.upload.max_bytes} bytes`);
  }

  options.onProgress?.(0, bytes.byteLength);
  const upload = await fetch(registered.upload.url, {
    method: 'PUT',
    body: new Blob([Uint8Array.from(bytes).buffer], { type: mediaType }),
    signal: options.signal,
    headers: {
      'content-type': mediaType,
      'x-upsert': 'false',
    },
  });
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '');
    throw new Error(`App artifact upload failed with HTTP ${upload.status}${detail ? `: ${detail}` : ''}`);
  }
  options.onProgress?.(bytes.byteLength, bytes.byteLength);

  return finalizeAppArtifact(projectId, registered.artifact.artifact_id, {
    sha256: await sha256Hex(bytes),
    size_bytes: bytes.byteLength,
  });
}

export async function createAppDeployment(
  projectId: string,
  appId: string,
  input: CreateAppDeploymentInput,
): Promise<AppDeployment> {
  return unwrap(
    await backendApi.post<AppDeployment>(`/projects/${projectId}/apps/${appId}/deployments`, input),
    'Failed to create App deployment',
  );
}

export async function listAppDeployments(projectId: string, appId: string): Promise<AppDeployment[]> {
  const data = unwrap(
    await backendApi.get<{ deployments: AppDeployment[] }>(
      `/projects/${projectId}/apps/${appId}/deployments`,
    ),
    'Failed to list App deployments',
  );
  return data.deployments;
}

export async function getAppDeployment(
  projectId: string,
  appId: string,
  deploymentId: string,
): Promise<AppDeploymentDetail> {
  return unwrap(
    await backendApi.get<AppDeploymentDetail>(
      `/projects/${projectId}/apps/${appId}/deployments/${deploymentId}`,
    ),
    'Failed to load App deployment',
  );
}

export async function getAppDeploymentLogs(
  projectId: string,
  appId: string,
  deploymentId: string,
  options: AppLogsOptions = {},
): Promise<AppLogsResponse> {
  const query = new URLSearchParams();
  if (options.after !== undefined) query.set('after', String(options.after));
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size ? `?${query.toString()}` : '';
  return unwrap(
    await backendApi.get<AppLogsResponse>(
      `/projects/${projectId}/apps/${appId}/deployments/${deploymentId}/logs${suffix}`,
    ),
    'Failed to load App logs',
  );
}

export async function startApp(projectId: string, appId: string): Promise<App> {
  return unwrap(
    await backendApi.post<App>(`/projects/${projectId}/apps/${appId}/start`, {}),
    'Failed to start App',
  );
}

export async function stopApp(projectId: string, appId: string): Promise<App> {
  return unwrap(
    await backendApi.post<App>(`/projects/${projectId}/apps/${appId}/stop`, {}),
    'Failed to stop App',
  );
}

export interface DeleteAppDeploymentResult {
  ok: boolean;
  deployment_id: string;
  /**
   * `released`: the provider no longer holds the deployment's image.
   * `pending`: not released yet (a stopping sandbox pins it, or the provider
   *   call failed); the platform retries the delete.
   * `none`: the deployment never built an image.
   */
  image: 'released' | 'pending' | 'none';
}

/**
 * Deletes one deployment, its runtime, and its image. The live deployment
 * (`409 deployment_live`) and an in-progress build (`409
 * deployment_in_progress`) are refused. A deleted deployment is no longer
 * listed and can no longer receive rollback traffic.
 */
export async function deleteAppDeployment(
  projectId: string,
  appId: string,
  deploymentId: string,
): Promise<DeleteAppDeploymentResult> {
  return unwrap(
    await backendApi.delete<DeleteAppDeploymentResult>(
      `/projects/${projectId}/apps/${appId}/deployments/${deploymentId}`,
    ),
    'Failed to delete App deployment',
  );
}

export async function rollbackApp(
  projectId: string,
  appId: string,
  deploymentId: string,
): Promise<App> {
  return unwrap(
    await backendApi.post<App>(`/projects/${projectId}/apps/${appId}/rollback`, {
      deployment_id: deploymentId,
    }),
    'Failed to roll back App',
  );
}
