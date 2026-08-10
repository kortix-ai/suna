// Sandbox templates + snapshot build log — template CRUD, snapshots, health.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ─── Sandbox templates + snapshot build log ──────────────────────────────

/** Lifecycle status of a single build attempt. */
export type WorkspaceSnapshotStatus = 'building' | 'ready' | 'failed';

/** Classified reason a snapshot build failed. */
/** Mirrors apps/api/src/snapshots/error-classify.ts — keep in sync. */
export type SnapshotErrorCategory =
  /** Daytona org snapshot quota exhausted — infra, not repo-fixable. */
  | 'quota'
  | 'dockerfile'
  /** A step in the Kortix-injected runtime layer failed — platform's fault, not the repo's. */
  | 'layer'
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
   * on every supported provider. The legacy single state follows the workspace's
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

export interface WorkspaceSnapshotBuild {
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
  status: WorkspaceSnapshotStatus;
  error: string | null;
  error_category: SnapshotErrorCategory | null;
  /** Server-derived: can an in-sandbox agent plausibly fix this by editing the repo? */
  fixable_by_agent: boolean;
  source: 'session-start' | 'workspace-create' | 'cr-merge' | 'manual' | 'background' | 'startup' | null;
  /** Exact provider recorded for new builds; null/absent on historical rows. */
  provider?: 'daytona' | 'platinum' | 'e2b' | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * Whether a session can boot from this workspace's sandbox right now, and if not
 * why. Server-derived from LIVE per-provider observation of the current image —
 * never from the build log alone, which cannot tell a failure that still applies
 * from one whose image the provider has since brought up.
 *
 * Render alerts from this, never from `latest_failure`.
 */
export type SandboxRuntimeState =
  /** Every provider this workspace can route to holds the current image. */
  | 'ready'
  /** The current image is building somewhere. Sessions may wait, not fail. */
  | 'building'
  /** No image yet and nothing failed — the next session start builds one. */
  | 'not_built'
  /** Usable on some routable providers, failed on others. */
  | 'degraded'
  /** No usable image anywhere this workspace routes, and the last attempt failed. */
  | 'blocked'
  /** Providers could not be observed. Show nothing. */
  | 'unknown';

/** Why a failed build no longer applies. History only — never an alert. */
export type SandboxStaleFailureReason = 'superseded' | 'recovered' | 'retrying';

export interface SandboxRuntimeStatus {
  state: SandboxRuntimeState;
  /** Content-addressed image the current template definition resolves to. */
  snapshot_name: string | null;
  /** The failure that still describes that image. Only set when it still bites. */
  current_failure: WorkspaceSnapshotBuild | null;
  /** Newest failed attempt that no longer applies. */
  stale_failure: WorkspaceSnapshotBuild | null;
  stale_reason: SandboxStaleFailureReason | null;
  ready_providers: string[];
  building_providers: string[];
  failed_providers: string[];
  /**
   * Whether `fixSandboxWithAgent` would be accepted right now — the failure is
   * repo-fixable AND a working image exists to host the fix session. Gate the
   * button on this; re-deriving it client-side drifts from what the API accepts.
   */
  fix_with_agent_available: boolean;
}

export interface WorkspaceSnapshotsResponse {
  templates: SandboxTemplate[];
  templates_error: string | null;
  builds: WorkspaceSnapshotBuild[];
  /** Absent on a degraded/older API response — treat as "no alert". */
  status?: SandboxRuntimeStatus | null;
  provider_mode?: 'automatic' | 'pinned';
  selected_provider?: 'daytona' | 'platinum' | 'e2b' | null;
  /** Whether the warm pool feature is enabled platform-wide (gates the per-row control). */
  warm_pool_available?: boolean;
}

export interface WorkspaceSandboxHealth {
  primary_slug: string | null;
  primary_template: SandboxTemplate | null;
  ready: boolean;
  building: boolean;
  latest_build: WorkspaceSnapshotBuild | null;
  /**
   * The newest failed row in the build log, whether or not it still describes
   * anything bootable. Diagnostic only — drive alerts from `status`.
   */
  latest_failure: WorkspaceSnapshotBuild | null;
  /** Absent on a degraded/older API response — treat as "no alert". */
  status?: SandboxRuntimeStatus | null;
  provider_mode?: 'automatic' | 'pinned';
  selected_provider?: 'daytona' | 'platinum' | 'e2b' | null;
}

export interface RebuildSnapshotResponse {
  status: 'started';
  slug: string;
  deleted_existing: boolean;
  snapshot_name: string;
  providers?: Array<'daytona' | 'platinum' | 'e2b'>;
  failed_providers?: Array<'daytona' | 'platinum' | 'e2b'>;
}

/**
 * List a workspace's sandbox **templates** (Dockerfile/image/warm-pool config) —
 * NOT the legacy one-workspace-one-sandbox instances. The endpoint path keeps the
 * historical `/sandboxes` name; the function is named for what it returns.
 */
export async function listWorkspaceSandboxTemplates(workspaceId: string) {
  return unwrap(
    await backendApi.get<SandboxTemplatesResponse>(
      `/workspaces/${workspaceId}/sandboxes`,
    ),
  );
}

export async function listWorkspaceSnapshots(workspaceId: string) {
  return unwrap(
    await backendApi.get<WorkspaceSnapshotsResponse>(
      `/workspaces/${workspaceId}/snapshots`,
    ),
  );
}

export async function getWorkspaceSandboxHealth(workspaceId: string) {
  return unwrap(
    await backendApi.get<WorkspaceSandboxHealth>(
      `/workspaces/${workspaceId}/sandbox-health`,
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

export async function rebuildWorkspaceSnapshot(workspaceId: string, slug?: string) {
  return unwrap(
    await backendApi.post<RebuildSnapshotResponse>(
      `/workspaces/${workspaceId}/snapshots/rebuild`,
      slug ? { slug } : {},
    ),
  );
}

export async function fixSandboxWithAgent(workspaceId: string) {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/workspaces/${workspaceId}/snapshots/fix-with-agent`,
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
  workspaceId: string,
  input: CreateSandboxTemplateInput,
) {
  return unwrap(
    await backendApi.post<{ template_id: string; slug: string }>(
      `/workspaces/${workspaceId}/sandbox-templates`,
      input,
    ),
  );
}

export async function updateSandboxTemplate(
  workspaceId: string,
  templateId: string,
  input: UpdateSandboxTemplateInput,
) {
  return unwrap(
    await backendApi.patch<{ template_id: string; slug: string }>(
      `/workspaces/${workspaceId}/sandbox-templates/${templateId}`,
      input,
    ),
  );
}

export async function deleteSandboxTemplate(workspaceId: string, templateId: string) {
  return unwrap(
    await backendApi.delete<null>(
      `/workspaces/${workspaceId}/sandbox-templates/${templateId}`,
    ),
  );
}

export async function buildSandboxTemplate(workspaceId: string, templateId: string) {
  return unwrap(
    await backendApi.post<{
      status: 'started';
      template_id: string;
      slug: string;
      providers?: Array<'daytona' | 'platinum' | 'e2b'>;
    }>(
      `/workspaces/${workspaceId}/sandbox-templates/${templateId}/build`,
      {},
    ),
  );
}

export async function listWorkspaceSandboxes(workspaceId: string) {
  return unwrap(
    await backendApi.get<SandboxTemplatesResponse>(`/workspaces/${workspaceId}/sandboxes`),
  );
}
