/**
 * Pure serialization for the provider-migration workflow's API surface. NO
 * db / provider / config / env imports (only the pure core + a type-only row
 * import), so the PATCH-response and poll-endpoint shapes are unit-testable in
 * isolation without booting the server / validating env.
 */
import {
  LIVE_TRANSITION_STATUSES,
  TERMINAL_TRANSITION_STATUSES,
  preparationLabel,
} from './provider-transition-core';
import { z } from 'zod';
import type { ProviderTransitionRow } from './provider-transition-store';

/**
 * The one zod shape for the prepare-branch PATCH body — the wire shape this
 * module owns and `lib/app.ts` brands for OpenAPI. `status` is the real
 * transition-status union (plus the two synthetic PATCH outcomes), not a bare
 * string: the hand-written OpenAPI copy used to loosen it and drift from the
 * `PreparationView` type below, which is now derived from this schema.
 */
export const PreparationViewSchema = z.object({
  kind: z.literal('preparation'),
  transition_id: z.string().nullable(),
  project_id: z.string(),
  status: z
    .enum([...LIVE_TRANSITION_STATUSES, ...TERMINAL_TRANSITION_STATUSES] as const)
    .or(z.literal('noop'))
    .or(z.literal('cleared')),
  source_provider: z.string().nullable(),
  target_provider: z.string().nullable(),
  active_provider: z.string().nullable(),
  label: z.string(),
  generation: z.number().nullable(),
  snapshot_name: z.string().nullable(),
  external_template_id: z.string().nullable(),
  commit_sha: z.string().nullable(),
  attempts: z.number(),
  last_error: z.string().nullable(),
  error_class: z.string().nullable(),
  requested_at: z.string().nullable(),
  ready_at: z.string().nullable(),
  activated_at: z.string().nullable(),
  immediate: z.boolean(),
});

export type PreparationView = z.infer<typeof PreparationViewSchema>;

/**
 * The one zod shape for the PUBLIC projection below; the `PublicTransitionView`
 * type is derived from it, so the projection and its OpenAPI copy cannot drift.
 */
export const PublicTransitionViewSchema = z.object({
  transition_id: z.string().nullable(),
  project_id: z.string(),
  status: z
    .enum([...LIVE_TRANSITION_STATUSES, ...TERMINAL_TRANSITION_STATUSES] as const)
    .or(z.literal('noop'))
    .or(z.literal('cleared')),
  source_provider: z.string().nullable(),
  target_provider: z.string().nullable(),
  generation: z.number().nullable(),
  label: z.string(),
  error_class: z.string().nullable(),
  requested_at: z.string().nullable(),
  ready_at: z.string().nullable(),
  activated_at: z.string().nullable(),
  immediate: z.boolean(),
});

export type PublicTransitionView = z.infer<typeof PublicTransitionViewSchema>;

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
