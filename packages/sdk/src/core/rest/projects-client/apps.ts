// Kortix Apps — project-scoped, provider-neutral application deployments.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type AppHostingProvider = 'daytona' | 'platinum' | 'e2b';
export type AppDesiredState = 'running' | 'stopped';
export type AppAccessMode = 'private' | 'project' | 'restricted' | 'public' | 'password';
export type AppArtifactKind = 'archive' | 'oci_image';
export type AppArtifactStatus = 'uploading' | 'uploaded' | 'ready' | 'rejected' | 'deleted';
export type AppSourceKind = 'static' | 'bundle' | 'dockerfile' | 'oci_image';
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
  slug: string;
  name: string;
  url: string;
  access_mode: AppAccessMode;
  access_revision: number;
  desired_state: AppDesiredState;
  active_deployment_id: string | null;
  machine: AppMachineSpec;
  idle_timeout_seconds: number;
  monthly_budget_usd: number;
  last_request_at: string | null;
  /**
   * May the caller OPEN this App, as opposed to merely see it listed?
   *
   * These are different verdicts. A project manager is shown every App in the
   * project so a private one stays manageable when its creator leaves, which
   * says nothing about whether they may look at it. Check this before asking
   * for an access session; asking anyway is how a grid of Apps turns into a
   * console full of 403s.
   *
   * Optional for wire compatibility with a server that predates the field.
   * Treat `undefined` as "unknown", not as "denied".
   */
  viewer_can_access?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateAppInput {
  slug: string;
  name: string;
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
  idle_timeout_seconds?: number;
  monthly_budget_usd?: number;
}

export interface UpdateAppInput {
  name?: string;
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
  idle_timeout_seconds?: number;
  monthly_budget_usd?: number;
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

export interface CreateAppDeploymentInput {
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
  artifact_id: string;
  version: number;
  status: AppDeploymentStatus;
  source_kind: AppSourceKind;
  hosting_type: 'sandbox';
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

export async function deleteApp(projectId: string, appId: string): Promise<{ ok: boolean }> {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/projects/${projectId}/apps/${appId}`),
    'Failed to delete App',
  );
}

export async function getAppAccess(projectId: string, appId: string): Promise<AppAccessConfig> {
  return unwrap(
    await backendApi.get<AppAccessConfig>(`/projects/${projectId}/apps/${appId}/access`),
    'Failed to load App access policy',
  );
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
