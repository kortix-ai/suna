/**
 * Pure serialization for the provider-migration workflow's API surface. NO
 * db / provider / config / env imports (only the pure core + a type-only row
 * import), so the PATCH-response and poll-endpoint shapes are unit-testable in
 * isolation without booting the server / validating env.
 */
import { preparationLabel, type ProviderTransitionStatus } from './provider-transition-core';
import type { ProviderTransitionRow } from './provider-transition-store';

/**
 * The prepare-branch body of PATCH /:projectId/sandbox-provider (the durable
 * transition the UI polls). Carries an explicit `kind` discriminant so the PATCH
 * response union ({ kind:'project' } | { kind:'preparation' }) is unambiguous — a
 * structural union alone would force clients to shape-sniff.
 */
export interface PreparationView {
  kind: 'preparation';
  transition_id: string | null;
  project_id: string;
  status: ProviderTransitionStatus | 'noop' | 'cleared';
  source_provider: string | null;
  target_provider: string | null;
  active_provider: string | null;
  label: string;
  generation: number | null;
  snapshot_name: string | null;
  external_template_id: string | null;
  commit_sha: string | null;
  attempts: number;
  last_error: string | null;
  error_class: string | null;
  requested_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  immediate: boolean;
}

export function serializeTransition(
  row: ProviderTransitionRow,
  activeProvider: string | null,
  opts: { immediate?: boolean } = {},
): PreparationView {
  return {
    kind: 'preparation',
    transition_id: row.transitionId,
    project_id: row.projectId,
    status: row.status,
    source_provider: row.sourceProvider,
    target_provider: row.targetProvider,
    active_provider: activeProvider,
    label: preparationLabel(row.status, row.targetProvider, row.sourceProvider),
    generation: row.generation,
    snapshot_name: row.snapshotName,
    external_template_id: row.externalTemplateId,
    commit_sha: row.commitSha,
    attempts: row.attempts ?? 0,
    last_error: row.lastError,
    error_class: row.errorClass,
    requested_at: row.requestedAt?.toISOString() ?? null,
    ready_at: row.readyAt?.toISOString() ?? null,
    activated_at: row.activatedAt?.toISOString() ?? null,
    immediate: opts.immediate ?? false,
  };
}

/**
 * The PUBLIC projection served by GET /:projectId/sandbox-provider/transition.
 * Deliberately DROPS internal build/lease detail — the raw provider error string
 * (`last_error`), the internal image name (`snapshot_name`), the provider template
 * id (`external_template_id`), and the retry `attempts` count — exposing only
 * status / providers / generation / timestamps / a user-safe error CLASS + label.
 * (`lease_epoch` and the lease holder never appear in `PreparationView` in the
 * first place, so they cannot leak through this projection either.) No `kind`
 * discriminant — the poll response is a single shape, not the PATCH result union.
 */
export interface PublicTransitionView {
  transition_id: string | null;
  project_id: string;
  status: ProviderTransitionStatus | 'noop' | 'cleared';
  source_provider: string | null;
  target_provider: string | null;
  generation: number | null;
  label: string;
  error_class: string | null;
  requested_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  immediate: boolean;
}

export function toPublicTransitionView(v: PreparationView): PublicTransitionView {
  return {
    transition_id: v.transition_id,
    project_id: v.project_id,
    status: v.status,
    source_provider: v.source_provider,
    target_provider: v.target_provider,
    generation: v.generation,
    label: v.label,
    error_class: v.error_class,
    requested_at: v.requested_at,
    ready_at: v.ready_at,
    activated_at: v.activated_at,
    immediate: v.immediate,
  };
}

export interface PublicTransitionState {
  active_provider: string | null;
  latest: PublicTransitionView | null;
  history: PublicTransitionView[];
}

export function toPublicTransitionState(state: {
  active_provider: string | null;
  latest: PreparationView | null;
  history: PreparationView[];
}): PublicTransitionState {
  return {
    active_provider: state.active_provider,
    latest: state.latest ? toPublicTransitionView(state.latest) : null,
    history: state.history.map(toPublicTransitionView),
  };
}
