/**
 * Session-metadata keys that only the server writes.
 *
 * `project_sessions.metadata` is one jsonb object with two writers. Clients
 * write free-form keys through `POST /sessions` and `PATCH /sessions/:id`
 * (`metadata`, documented as client metadata in `@kortix/sdk`). Server code
 * writes keys that later code TRUSTS: for attribution, credential minting,
 * channel reply targets, trigger routing, and data restore. A key in the
 * second group that a client can also write lets the client decide what the
 * server trusts.
 *
 * The rule: every key that server code reads for a decision is listed here,
 * and both routes refuse a request that names one (`400`). Add the key here in
 * the same change that adds the server reader.
 */
import { WARM_SESSION_LOCATION_KEY } from './warm-sessions';

export const SERVER_MANAGED_SESSION_METADATA_KEYS = [
  // Soft delete (`deleteSession`).
  'forkedFromSessionId',
  'deletedAt',
  'deletedBy',
  // Model pin (`opencode_model` body field and `PUT …/model`). `_repointed_from`
  // is stamped only by session-model-repoint.ts, when a retired managed id gets
  // moved to a servable one at boot — a client value here would forge history.
  'opencode_model',
  'opencode_model_source',
  'opencode_model_repointed_from',
  // The gateway fallback record (`llm-gateway/resolution/session-model-fallback.ts`).
  // The turn-end revert writes `_from` into the pin: a client value would pick it.
  'opencode_model_fallback_from',
  'opencode_model_fallback_from_source',
  'opencode_model_fallback_reason',
  'opencode_model_fallback_at',
  'opencode_model_fallback_until',
  // When a person last picked the model: a fallback switch from a request
  // that started before it skips the session.
  'opencode_model_picked_at',
  // The revert's "no prompt ran on the restored pin yet" marker: it makes
  // prompts carry the pin (`prompt-model.ts`).
  'opencode_model_restored',
  // Invocation and trigger attribution. `on_behalf_of` minting, the audit
  // origin, and keyed-trigger routing (`trigger_session_key`) read these.
  'source',
  'trigger_kind',
  'trigger_slug',
  'trigger_source',
  'trigger_type',
  'trigger_session_key',
  // Titles (`projects/session-title-generate.ts`). Renames use `body.name`.
  'name',
  'title_source',
  // A channel thread's top message (`session-create.ts`): the creator's first
  // prompt, shown to every member of the channel.
  'first_prompt',
  // The initial turn's harness context, server-read by the initial-turn claim.
  'initial_context',
  // Agents as principals (spec 2026-09-22 §2.3): the mint reads these to decide
  // `on_behalf_of`. A client that could set `spawned_by_session` would inherit
  // another session's human; one that could forge the cleared stamp is harmless
  // but still not the client's to write.
  'spawned_by_session',
  'on_behalf_of_cleared_at',
  // Lost-session recovery (KRTX-2419): its boxes restore
  // from the session log at boot (`recover-lost-session.ts`).
  'lostRecoveredAt',
  // A restored deleted session (`restore-session.ts`): its boxes restore from
  // the session log at boot too.
  'restoredAt',
  // Legacy migration restore. Selects the archive that session open and
  // restart copy into the sandbox (`legacy-migration-rehydrate.ts`).
  'legacy_migration',
  // Channel origin. Reply targets and the channel runtime env
  // (`session-channel-env.ts`, the Slack/Teams/email/Telegram relays).
  'slack',
  'teams',
  'email',
  'telegram',
  // Warm-session marker and trusted provisioning intent (`lib/warm-sessions.ts`).
  'warm',
  WARM_SESSION_LOCATION_KEY,
  // Activity-ordered session list (`session-list.ts` `orderByActivity`). The
  // server stamps conversation activity; a client value would let it fake a
  // sidebar position.
  'last_activity_at',
  // Server-confirmed runtime fork provenance and inventory.
  'runtime_forks',
  'opencode_sessions',
] as const;

/**
 * PATCH also refuses keys that `POST` stamps unconditionally after the client
 * spread, so on create a client value is overwritten and on update it would
 * persist.
 */
/**
 * Keys a client may write, but only on a session it owns: the session's
 * creator, or the session itself through its own session-bound token.
 * Server code trusts them for a decision, so a member who can merely SEE a
 * session must not set them. `POST /sessions` accepts them (the caller owns
 * the session it creates).
 *
 * - `unattended`: the server answers the session's blocking questions at once
 *   (`channels/question-release.ts`), removing the owner's confirmation step.
 */
export const OWNER_MANAGED_SESSION_METADATA_KEYS = ['unattended'] as const;

export const PATCH_SERVER_MANAGED_SESSION_METADATA_KEYS = [
  ...SERVER_MANAGED_SESSION_METADATA_KEYS,
  'workspace_mode',
  'repository_access',
  'repository_generation',
  'sandbox_slug',
  'audit_v2',
] as const;
