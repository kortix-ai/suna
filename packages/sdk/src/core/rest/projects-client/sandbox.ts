// Sandbox templates + snapshot build log — template CRUD, snapshots, health.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ─── Sandbox templates + snapshot build log ──────────────────────────────

/** Lifecycle status of a single build attempt. */
export type ProjectSnapshotStatus = 'building' | 'ready' | 'failed';

/** Classified reason a snapshot build failed. */
/** Mirrors apps/api/src/snapshots/error-classify.ts — keep in sync. */
export type SnapshotErrorCategory =
  /** Daytona org snapshot quota exhausted — infra, not repo-fixable. */
  | 'quota'
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
  /**
   * Fresh launch-readiness observations for this exact content-addressed image
   * on every supported provider. The legacy single state follows the project's
   * routing mode; this array preserves the independent provider truth.
   */
  provider_coverage?: Array<{
    provider: 'daytona' | 'platinum' | 'e2b';
    available: boolean;
    snapshot_name: string;
    state: 'active' | 'building' | 'build_failed' | 'removing' | 'unknown' | 'missing' | null;
    status: 'ready' | 'building' | 'failed' | 'not_built' | 'unavailable' | 'unknown';
    launch_ready: boolean;
    observed_at: string | null;
  }>;
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
  provider_mode?: 'automatic' | 'pinned';
  selected_provider?: 'daytona' | 'platinum' | 'e2b' | null;
  /** Whether the warm pool feature is enabled platform-wide. */
  warm_pool_available?: boolean;
}

export interface ProjectSnapshotBuild {
  build_id: string;
  /**
   * The build-log slug. For a warm bake this is `<template>-warm`, which names NO
   * template. Never feed this back to an API that expects a template slug — use
   * `template_slug`.
   */
  slug: string;
  /** The template this build was for. Safe to pass to rebuild / session create. */
  template_slug: string;
  snapshot_name: string;
  content_hash: string;
  status: ProjectSnapshotStatus;
  error: string | null;
  error_category: SnapshotErrorCategory | null;
  /** Server-derived: can an in-sandbox agent plausibly fix this by editing the repo? */
  fixable_by_agent: boolean;
  source: 'session-start' | 'project-create' | 'cr-merge' | 'manual' | 'background' | 'startup' | null;
  /** Exact provider recorded for new builds; null/absent on historical rows. */
  provider?: 'daytona' | 'platinum' | 'e2b' | null;
  started_at: string;
  finished_at: string | null;
}

export interface ProjectSnapshotsResponse {
  templates: SandboxTemplate[];
  templates_error: string | null;
  builds: ProjectSnapshotBuild[];
  provider_mode?: 'automatic' | 'pinned';
  selected_provider?: 'daytona' | 'platinum' | 'e2b' | null;
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
  provider_mode?: 'automatic' | 'pinned';
  selected_provider?: 'daytona' | 'platinum' | 'e2b' | null;
}

export interface RebuildSnapshotResponse {
  status: 'started';
  slug: string;
  deleted_existing: boolean;
  snapshot_name: string;
  providers?: Array<'daytona' | 'platinum' | 'e2b'>;
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
    await backendApi.post<{
      status: 'started';
      template_id: string;
      slug: string;
      providers?: Array<'daytona' | 'platinum' | 'e2b'>;
    }>(
      `/projects/${projectId}/sandbox-templates/${templateId}/build`,
      {},
    ),
  );
}

export async function listProjectSandboxes(projectId: string) {
  return unwrap(
    await backendApi.get<SandboxTemplatesResponse>(`/projects/${projectId}/sandboxes`),
  );
}
