import { backendApi } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────────
//
// Mirror the response shapes from `/v1/projects/:id/apps/*` in
// suna/apps/api/src/projects/index.ts. The platform serializes apps in
// snake_case so we keep that on the wire and translate at the component
// boundary when needed.

export type AppSourceGit = {
  type: 'git';
  repo: string | null;
  branch: string | null;
  root_path: string | null;
};

export type AppSourceTar = {
  type: 'tar';
  url: string;
};

export type AppSource = AppSourceGit | AppSourceTar;

export interface AppBuild {
  command: string | null;
  out_dir: string | null;
}

// Mirrors the `deployment_status` DB enum. `pending`/`building`/`deploying`
// are in-progress; `active`/`failed`/`stopped` are terminal.
export type DeploymentStatus =
  | 'pending'
  | 'building'
  | 'deploying'
  | 'active'
  | 'failed'
  | 'stopped';

export interface ProjectAppDeploymentRow {
  deployment_id: string;
  account_id: string;
  project_id: string | null;
  app_slug: string | null;
  provider: string | null;
  status: DeploymentStatus;
  source_type: 'git' | 'tar';
  source_ref: string | null;
  framework: string | null;
  domains: string[] | null;
  live_url: string | null;
  env_vars: Record<string, string> | null;
  build_config: Record<string, unknown> | null;
  error: string | null;
  version: number;
  freestyle_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectApp {
  slug: string;
  path: string;
  name: string;
  enabled: boolean;
  domains: string[];
  framework: string | null;
  source: AppSource;
  build: AppBuild | null;
  env: Record<string, string>;
  manifest_hash: string;
  latest_deployment: ProjectAppDeploymentRow | null;
  drift: boolean;
}

export interface ProjectAppParseError {
  slug: string;
  path: string;
  error: string;
}

export interface ListProjectAppsResponse {
  apps: ProjectApp[];
  errors: ProjectAppParseError[];
}

export interface CreateOrUpdateProjectAppInput {
  slug?: string;
  name?: string;
  enabled?: boolean;
  /** Leave empty / omit to let the deployment provider issue an auto-domain
   *  (Freestyle hands out a `*.style.dev` subdomain). */
  domains?: string[];
  framework?: string | null;
  source: AppSource;
  build?: AppBuild | null;
  env?: Record<string, string>;
}

// ─── Client ────────────────────────────────────────────────────────────────

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }) {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Projects apps request failed');
  }
  return response.data;
}

const base = (projectId: string) => `/projects/${projectId}/apps`;

export async function listProjectApps(projectId: string): Promise<ListProjectAppsResponse> {
  return unwrap(await backendApi.get<ListProjectAppsResponse>(base(projectId)));
}

export async function createProjectApp(
  projectId: string,
  input: CreateOrUpdateProjectAppInput,
): Promise<ListProjectAppsResponse> {
  return unwrap(await backendApi.post<ListProjectAppsResponse>(base(projectId), input));
}

export async function updateProjectApp(
  projectId: string,
  slug: string,
  input: Partial<CreateOrUpdateProjectAppInput>,
): Promise<ListProjectAppsResponse> {
  return unwrap(await backendApi.patch<ListProjectAppsResponse>(`${base(projectId)}/${slug}`, input));
}

export async function deleteProjectApp(
  projectId: string,
  slug: string,
): Promise<ListProjectAppsResponse> {
  return unwrap(await backendApi.delete<ListProjectAppsResponse>(`${base(projectId)}/${slug}`));
}

export interface DeployProjectAppResponse {
  status: 'active' | 'failed';
  app_slug: string;
  deployment: ProjectAppDeploymentRow | null;
}

export async function deployProjectApp(
  projectId: string,
  slug: string,
): Promise<DeployProjectAppResponse> {
  return unwrap(await backendApi.post<DeployProjectAppResponse>(
    `${base(projectId)}/${slug}/deploy`,
    {},
  ));
}

export interface StopProjectAppResponse {
  ok: boolean;
  deployment: ProjectAppDeploymentRow | null;
}

export async function stopProjectApp(
  projectId: string,
  slug: string,
): Promise<StopProjectAppResponse> {
  return unwrap(await backendApi.post<StopProjectAppResponse>(
    `${base(projectId)}/${slug}/stop`,
    {},
  ));
}

export interface ProjectAppLogsResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export async function getProjectAppLogs(
  projectId: string,
  slug: string,
): Promise<ProjectAppLogsResponse> {
  return unwrap(await backendApi.get<ProjectAppLogsResponse>(`${base(projectId)}/${slug}/logs`));
}
