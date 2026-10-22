// Kortix Apps — project-scoped, provider-neutral applications. Clients branch
// on an App's `capabilities`.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Platinum is the reference App host. Daytona is a legacy fallback. */
export type AppHostingProvider = 'platinum' | 'daytona';
export type AppDesiredState = 'running' | 'stopped';
export type AppAccessMode = 'private' | 'project' | 'restricted' | 'public' | 'password';
export type AppArtifactKind = 'archive' | 'oci_image';
export type AppArtifactStatus = 'uploading' | 'uploaded' | 'ready' | 'rejected' | 'deleted';
export type AppSourceKind = 'static' | 'bundle' | 'dockerfile' | 'oci_image';

/**
 * What an App supports now. The only thing a client branches on. A route
 * for a capability the App lacks answers `409 app_capability_unsupported`.
 *
 * - `deployments`: has a deployment history.
 * - `rollback`: traffic can move to an older ready deployment.
 * - `preview`: opens in a browser through an access session.
 * - `sleep`: a server that stops when idle (`start` / `stop`).
 * - `static`: served from storage, no runtime.
 * - `member_tokens`: Kortix sign-in tokens for the App ({@link createAppToken}).
 */
export type AppCapability =
  | 'deployments'
  | 'rollback'
  | 'preview'
  | 'sleep'
  | 'static'
  | 'member_tokens'
  | 'machines'
  | 'scale'
  | 'exec'
  | 'volumes'
  | 'snapshots';

/* ─── The release config (kortix.yaml `apps.<name>`) ─── */

export type AppDeployStrategy = 'rolling' | 'immediate' | 'bluegreen' | 'canary';
export type AppAutoStop = 'off' | 'stop' | 'suspend';
/** `public`: no gate (the service checks sign-in itself). `app`: the App's access policy. `admins`: project admins. */
export type AppServiceAccess = 'public' | 'app' | 'admins';

export interface AppCheck {
  type: 'http' | 'tcp';
  port?: number;
  path?: string;
  interval_s: number;
  timeout_s: number;
  grace_period_s: number;
}

export interface AppServiceConfig {
  /** `http` is the primary service, on the App's own host. */
  name: string;
  internal_port: number;
  protocol: 'http' | 'tcp';
  access: AppServiceAccess;
  auto_stop_machines: AppAutoStop;
  auto_start_machines: boolean;
  min_machines_running: number;
  processes: string[];
  checks: AppCheck[];
}

export interface AppMountConfig {
  source: string;
  destination: string;
  initial_size_gb: number;
  snapshot_retention_days: number;
  processes: string[];
}

export interface AppVmConfig {
  cpu: number;
  memory_gb: number;
  disk_gb: number;
  processes: string[];
}

/** A release's resolved config: what the platform runs. */
export interface AppReleaseConfig {
  processes: Record<string, string>;
  services: AppServiceConfig[];
  mounts: AppMountConfig[];
  vm: AppVmConfig[];
  deploy: { strategy: AppDeployStrategy; release_command: string | null };
}

type Partial2<T> = { [K in keyof T]?: T[K] extends Array<infer U> ? Array<Partial<U>> : T[K] };

/** The authored config a deploy sends: every field optional, plus the shorthands. */
export interface AppReleaseConfigInput {
  processes?: Record<string, string>;
  http_service?: Partial2<Omit<AppServiceConfig, 'name'>>;
  services?: Array<Partial2<AppServiceConfig>>;
  mounts?: Array<Partial<AppMountConfig>>;
  vm?: Partial<AppVmConfig> | Array<Partial<AppVmConfig>>;
  deploy?: { strategy?: AppDeployStrategy; release_command?: string | null };
  port?: number;
  command?: string;
  readiness_path?: string;
  always_on?: boolean;
  resources?: { cpu?: number; memory_gb?: number; disk_gb?: number };
}

/** A service of the active release as an App lists it, with its URL. */
export interface AppServiceSummary {
  name: string;
  protocol: 'http' | 'tcp';
  access: AppServiceAccess;
  internal_port: number;
  processes: string[];
  /** Null for a TCP service, or when the host label would be too long (reach it through a binding). */
  url: string | null;
}

/**
 * The public values that verify the Kortix sign-in tokens minted for an App:
 * the project issuer, `aud` = the App id, and the issuer's key set. No secret.
 */
export interface AppAuth {
  issuer: string;
  audience: string;
  jwks_uri: string;
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
  /** What the App supports now. Optional for wire compatibility with a server that predates it. */
  capabilities?: AppCapability[];
  slug: string;
  name: string;
  /** Where the App is reached: its Kortix host, or `external_url` for an external App. */
  url: string;
  /**
   * Set: the App is hosted elsewhere at this https URL. Kortix lists and frames
   * it and never deploys it. Its `capabilities` are `['preview']` when the site
   * allows framing, else `[]` (open it in a new tab). Optional for wire
   * compatibility with a server that predates it.
   */
  external_url?: string | null;
  access_mode: AppAccessMode;
  access_revision: number;
  desired_state: AppDesiredState;
  active_deployment_id: string | null;
  machine: AppMachineSpec;
  idle_timeout_seconds: number;
  /**
   * `true`: the App runs 24/7 (cron jobs, workers, websockets keep working)
   * and bills 24/7. `false`: it stops after
   * `idle_timeout_seconds` without requests and wakes on the next one. `false`
   * for a static App, which has no runtime. Optional for wire compatibility
   * with a server that predates it.
   */
  always_on?: boolean;
  /**
   * @deprecated Kortix shows no prices: never display this value. It stays on
   * the wire for compatibility and will be removed in a future major version.
   */
  estimated_monthly_usd?: number;
  /**
   * How the active deployment is hosted. `static`: served from storage, with
   * no runtime: it serves whatever `desired_state` says, and start/stop
   * answer `409 static_app_no_runtime`. `sandbox`: a server App. `null`: not
   * deployed yet. Optional for wire
   * compatibility with a server that predates it.
   */
  hosting_type?: 'sandbox' | 'static' | null;
  /**
   * Ready deployments the App keeps besides its active one, as rollback
   * targets. Older ones are retired. Optional for wire compatibility.
   */
  retained_deployments?: number;
  /** Set on the create and update responses only: `app_external_not_frameable` when an external site refuses a frame. */
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
  /** Free-form labels (e.g. `backend`): they group and filter, nothing more. Optional for wire compatibility. */
  labels?: string[];
  /** Where Kortix shows the App. Optional for wire compatibility; absent means the defaults. */
  display?: AppDisplay;
  /** Machines per process group; a group not listed runs one. Optional for wire compatibility. */
  scale?: Record<string, number>;
  /** The active release's services and their URLs. Optional for wire compatibility. */
  services?: AppServiceSummary[];
  /** Machine counts. Optional for wire compatibility. */
  machines?: { total: number; running: number; stopped: number };
  /** Volume count and allotted size. Optional for wire compatibility. */
  volumes?: { count: number; size_gb: number };
  /** The active release's config, or null (static App, never deployed). Optional for wire compatibility. */
  config?: AppReleaseConfig | null;
  created_at: string;
  updated_at: string;
}

/**
 * Where Kortix shows an App (`kortix.yaml` `apps.<name>.display`). Presentation
 * only: how the App runs and who may open it do not change.
 */
export interface AppDisplay {
  /** A card in the Apps grid. Default true; an App with a `parent` has none. */
  listed?: boolean;
  /** The card thumbnail: `live` frames the App, `none` shows an icon. Default `live`. */
  preview?: 'live' | 'none';
  /** The App, by slug, whose detail shows this one as a tab (a backend's admin dashboard). */
  parent?: string;
}

export interface CreateAppInput {
  slug: string;
  name: string;
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
  idle_timeout_seconds?: number;
  /** Run 24/7. Defaults to the server's setting (Kortix Cloud: `true`). */
  always_on?: boolean;
  /** The Apps, by slug, this App uses. Each must exist. Default: none. */
  uses?: string[];
  /** An https URL: create an external App that Kortix lists and frames, and never deploys. */
  external_url?: string;
}

export interface UpdateAppInput {
  name?: string;
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
  idle_timeout_seconds?: number;
  always_on?: boolean;
  /** Replaces the Apps this App uses. `[]` removes every link. */
  uses?: string[];
  /** Replaces the App's labels (each `^[a-z0-9][a-z0-9-]{0,30}$`, at most 10). */
  labels?: string[];
  /** Replaces where Kortix shows the App. `{}` restores the defaults. */
  display?: AppDisplay;
  /** Moves an external App to another https URL (`409 app_not_external` for an App Kortix runs). */
  external_url?: string;
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
  /** The primary service's port; omitted for a worker-only App. */
  port?: number;
  restart_limit?: number;
}

export interface OciImageAppSource extends BaseAppSource {
  kind: 'oci_image';
  image: string;
  command: string[];
  /** The primary service's port; omitted for a worker-only App. */
  port?: number;
  restart_limit?: number;
}

export type AppSource =
  | StaticAppSource
  | BundleAppSource
  | DockerfileAppSource
  | OciImageAppSource;

/** A build of an uploaded artifact. */
export type CreateAppDeploymentInput = CreateAppBuildInput;

export interface CreateAppBuildInput {
  artifact_id: string;
  source: AppSource;
  /** Optional infrastructure preference. Omit it to use the server policy. */
  provider?: AppHostingProvider;
  /** Non-secret runtime environment values. */
  environment?: Record<string, string>;
  /** Runtime environment key -> project secret identifier. */
  secrets?: Record<string, string>;
  /**
   * The release config. Omitted: one `app` process group on the
   * source port, sized like the App. Invalid: `400 app_config_invalid` with
   * `issues: [{path, message}]`.
   */
  config?: AppReleaseConfigInput;
}

export interface AppDeployment {
  deployment_id: string;
  app_id: string;
  /** `null` for a historic record made without an artifact. */
  artifact_id: string | null;
  version: number;
  status: AppDeploymentStatus;
  source_kind: AppSourceKind;
  /** `static`: served from storage, no runtime. `sandbox`: runs in its own machine. */
  hosting_type: 'sandbox' | 'static';
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
  /** The release's resolved config; `null` for a release made before releases carried one. */
  config: AppReleaseConfig | null;
  /** How this release rolls out; `null` before the worker resolves it. */
  strategy: AppDeployStrategy | null;
  /** The `deploy.release_command` outcome; `null` when the release has none. */
  release_command_status: 'running' | 'succeeded' | 'failed' | null;
  created_at: string;
  updated_at: string;
}

/** What `rollbackApp` resolves with: the App and the NEW release it queued from the target's artifact and config. */
export type AppRollback = App & { deployment: AppDeployment };

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

/** Deletes the App, its runtimes, and every deployment image it built. */
export async function deleteApp(
  projectId: string,
  appId: string,
): Promise<{ ok: boolean; images?: AppImageRelease }> {
  return unwrap(
    await backendApi.delete<{ ok: boolean; images?: AppImageRelease }>(`/projects/${projectId}/apps/${appId}`),
    'Failed to delete App',
  );
}

// ── Capability routes ────────────────────────────────────────────────────────

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

/** What verifies an App's Kortix sign-in tokens offline, as env values (public, no secret). */
export interface AppAuthEnv {
  KORTIX_AUTH_ISSUER: string;
  KORTIX_AUTH_AUDIENCE: string;
  /** The project key set inline, as a `data:application/json;base64,…` URL: the reader fetches nothing. */
  KORTIX_AUTH_JWKS: string;
}

/**
 * The env a backend needs to verify the App's sign-in tokens without a network
 * call (self-hosted Convex takes the key set as a URL and fetches nothing;
 * `verifyKortixToken` reads the same values). A rotated project key needs a re-run.
 */
export async function getAppAuthEnv(projectId: string, appId: string): Promise<AppAuthEnv> {
  const app = await getApp(projectId, appId);
  if (!app.auth) throw new Error('This server does not report sign-in values for Apps.');
  const keySet = unwrap(
    await backendApi.get<unknown>(`/projects/${projectId}/jwks.json`),
    'Failed to read the project key set',
  );
  const bytes = new TextEncoder().encode(JSON.stringify(keySet));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    KORTIX_AUTH_ISSUER: app.auth.issuer,
    KORTIX_AUTH_AUDIENCE: app.auth.audience,
    KORTIX_AUTH_JWKS: `data:application/json;base64,${btoa(binary)}`,
  };
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
): Promise<AppRollback> {
  return unwrap(
    await backendApi.post<AppRollback>(`/projects/${projectId}/apps/${appId}/rollback`, {
      deployment_id: deploymentId,
    }),
    'Failed to roll back App',
  );
}
