// Sandbox templates + snapshot build log — template CRUD, snapshots, health.

import { backendApi } from '../api-client';
import { unwrap } from './shared';

// ─── Sandbox templates + snapshot build log ──────────────────────────────

/** Lifecycle status of a single build attempt. */
export type ProjectSnapshotStatus = 'building' | 'ready' | 'failed';

/** Classified reason a snapshot build failed. */
export type SnapshotErrorCategory =
  | 'dockerfile'
  | 'tunnel'
  | 'provider'
  | 'timeout'
  | 'runtime'
  | 'git'
  | 'unknown';

/** A sandbox template: platform default + each `[[sandbox.templates]]` / UI-created entry. */
export interface SandboxTemplate {
  template_id: string | null;
  slug: string;
  name: string;
  is_default: boolean;
  source: 'platform' | 'toml' | 'ui';
  provider: string;
  has_dockerfile: boolean;
  has_image: boolean;
  image: string | null;
  dockerfile_path: string | null;
  entrypoint: string | null;
  cpu: number;
  memory_gb: number;
  disk_gb: number;
  snapshot_name: string;
  content_hash: string;
  built_from_commit: string | null;
  daytona_state: string;
  provider_state: string;
  ready: boolean;
  /** Per-template warm pool config + live counts. null when the operator gate
   *  is off (feature unavailable platform-wide). */
  warm_pool?: {
    enabled: boolean;
    size: number;
    /** Sandboxes parked and ready to claim instantly. */
    ready: number;
    /** Sandboxes currently booting toward ready. */
    warming: number;
  } | null;
}

export interface SandboxTemplatesResponse {
  items: SandboxTemplate[];
  default_slug: string | null;
  /** Whether the warm pool feature is enabled platform-wide. */
  warm_pool_available?: boolean;
}

export interface ProjectSnapshotBuild {
  build_id: string;
  slug: string;
  snapshot_name: string;
  content_hash: string;
  status: ProjectSnapshotStatus;
  error: string | null;
  error_category: SnapshotErrorCategory | null;
  source: 'session-start' | 'project-create' | 'cr-merge' | 'manual' | 'background' | 'startup' | null;
  started_at: string;
  finished_at: string | null;
}

export interface ProjectSnapshotsResponse {
  templates: SandboxTemplate[];
  templates_error: string | null;
  builds: ProjectSnapshotBuild[];
  /** Whether the warm pool feature is enabled platform-wide (gates the per-row control). */
  warm_pool_available?: boolean;
}

export interface ProjectSandboxHealth {
  primary_slug: string | null;
  primary_template: SandboxTemplate | null;
  ready: boolean;
  building: boolean;
  latest_build: ProjectSnapshotBuild | null;
  latest_failure: ProjectSnapshotBuild | null;
}

export interface RebuildSnapshotResponse {
  status: 'started';
  slug: string;
  deleted_existing: boolean;
  snapshot_name: string;
}

/**
 * List a project's sandbox **templates** (Dockerfile/image/warm-pool config) —
 * NOT the legacy one-project-one-sandbox instances. The endpoint path keeps the
 * historical `/sandboxes` name; the function is named for what it returns.
 */
export async function listProjectSandboxTemplates(projectId: string) {
  return unwrap(
    await backendApi.get<SandboxTemplatesResponse>(
      `/projects/${projectId}/sandboxes`,
    ),
  );
}

export async function listProjectSnapshots(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSnapshotsResponse>(
      `/projects/${projectId}/snapshots`,
    ),
  );
}

export async function getProjectSandboxHealth(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectSandboxHealth>(
      `/projects/${projectId}/sandbox-health`,
      {
        // Background poll used by alerts/settings. React Query owns retry/error
        // state; the global error handler would otherwise spam console.error
        // during transient dev boot or provider stalls.
        showErrors: false,
        timeout: 15_000,
      },
    ),
  );
}

export async function rebuildProjectSnapshot(projectId: string, slug?: string) {
  return unwrap(
    await backendApi.post<RebuildSnapshotResponse>(
      `/projects/${projectId}/snapshots/rebuild`,
      slug ? { slug } : {},
    ),
  );
}

export async function fixSandboxWithAgent(projectId: string) {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${projectId}/snapshots/fix-with-agent`,
      {},
    ),
  );
}

// ─── Template CRUD ────────────────────────────────────────────────────────

export interface CreateSandboxTemplateInput {
  slug: string;
  name?: string;
  image?: string;
  dockerfile_path?: string;
  entrypoint?: string;
  cpu?: number;
  memory_gb?: number;
  disk_gb?: number;
}

export interface UpdateSandboxTemplateInput {
  name?: string;
  image?: string | null;
  dockerfile_path?: string | null;
  entrypoint?: string | null;
  cpu?: number | null;
  memory_gb?: number | null;
  disk_gb?: number | null;
}

export async function createSandboxTemplate(
  projectId: string,
  input: CreateSandboxTemplateInput,
) {
  return unwrap(
    await backendApi.post<{ template_id: string; slug: string }>(
      `/projects/${projectId}/sandbox-templates`,
      input,
    ),
  );
}

export async function updateSandboxTemplate(
  projectId: string,
  templateId: string,
  input: UpdateSandboxTemplateInput,
) {
  return unwrap(
    await backendApi.patch<{ template_id: string; slug: string }>(
      `/projects/${projectId}/sandbox-templates/${templateId}`,
      input,
    ),
  );
}

export async function deleteSandboxTemplate(projectId: string, templateId: string) {
  return unwrap(
    await backendApi.delete<null>(
      `/projects/${projectId}/sandbox-templates/${templateId}`,
    ),
  );
}

export async function buildSandboxTemplate(projectId: string, templateId: string) {
  return unwrap(
    await backendApi.post<{ status: 'started'; template_id: string; slug: string }>(
      `/projects/${projectId}/sandbox-templates/${templateId}/build`,
      {},
    ),
  );
}
