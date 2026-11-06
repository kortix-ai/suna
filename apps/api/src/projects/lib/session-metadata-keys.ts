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
import { SUBAGENT_NOTIFY_PARENT_KEY } from '@kortix/api-contract/runtime-relay';

export const SERVER_MANAGED_SESSION_METADATA_KEYS = [
  // The router (`chat_front`): only session-create.ts marks a front (front-thread.ts).
  'kortix_front',
  // Thread files: the thread's folder name and message numbering (memory/thread-files.ts).
  'thread_files',
  // Chat: Kortix's own top-level message; only POST /chat/threads sets it (chat-threads.ts).
  'chat_root_text',
  // Space posts: the agent that wrote a top-level post, and its mentions (space-posts.ts).
  'chat_root_author',
  'chat_root_mentions',
  // Space watcher (`spaces_proactive`): the space a watcher watches, and the posts it made (space-watch/keys.ts).
  'space_watcher',
  'space_watcher_post',
  // Soft delete (`deleteSession`).
  'forkedFromSessionId',
  'deletedAt',
  'deletedBy',
  // Model pin (`model` body field and `PUT …/model`). `_repointed_from`
  // is stamped only by session-model-repoint.ts, when a retired managed id gets
  // moved to a servable one at boot — a client value here would forge history.
  'model',
  'model_switches',
  'model_source',
  'model_repointed_from',
  // The gateway fallback record (`llm-gateway/resolution/session-model-fallback.ts`).
  // The turn-end revert writes `_from` into the pin: a client value would pick it.
  'model_fallback_from',
  'model_fallback_from_source',
  'model_fallback_reason',
  'model_fallback_at',
  'model_fallback_until',
  // When a person last picked the model: a fallback switch from a request
  // that started before it skips the session.
  'model_picked_at',
  // The revert's "no prompt ran on the restored pin yet" marker: it makes
  // prompts carry the pin (`prompt-model.ts`).
  'model_restored',
  // Invocation and trigger attribution. `on_behalf_of` minting, the audit
  // origin, and keyed-trigger routing (`trigger_session_key`) read these.
  'source',
  'trigger_kind',
  'trigger_slug',
  // Shown as a channel thread's author (`trigger-fire.ts`).
  'trigger_name',
  'trigger_source',
  'trigger_type',
  'trigger_session_key',
  // Titles (`projects/session-title-generate.ts`). Renames use `body.name`.
  'name',
  'title_source',
  'title_fallback_attempts',
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
  // The session a failed reminder's successor replaces (`trigger-fire.ts`).
  // Telegram write confinement follows it (connectors/channel-write-scope.ts).
  'reminder_successor_of',
  // Lost-session recovery (KRTX-2419): its boxes restore
  // from the session log at boot (`recover-lost-session.ts`).
  'lostRecoveredAt',
  // A restored deleted session (`restore-session.ts`): its boxes restore from
  // the session log at boot too.
  'restoredAt',
  // Legacy migration provenance: the Suna migration wrote it and clients show
  // it. No client may forge it.
  'legacy_migration',
  // Channel origin. Reply targets and the channel runtime env
  // (`session-channel-env.ts`, the Slack/Teams/email/Telegram/Discord relays).
  'slack',
  'teams',
  'email',
  'telegram',
  'discord',
  // Activity-ordered session list (`session-list.ts` `orderByActivity`). The
  // server stamps conversation activity; a client value would let it fake a
  // sidebar position.
  'last_activity_at',
  // Server-confirmed runtime fork provenance and inventory.
  'runtime_forks',
  'runtime_sessions',
  // The session's /workspace volume (platform/services/workspace-volume.ts):
  // its boxes mount it and a delete deletes it.
  'workspace_volume',
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
 * - `notify_parent`: each finished turn is delivered into the parent session
 *   (`projects/subagent-notice.ts`, a background subagent).
 */
export const OWNER_MANAGED_SESSION_METADATA_KEYS = ['unattended', SUBAGENT_NOTIFY_PARENT_KEY] as const;

export const PATCH_SERVER_MANAGED_SESSION_METADATA_KEYS = [
  ...SERVER_MANAGED_SESSION_METADATA_KEYS,
  // Agent teams: the lead is fixed when the lead creates the teammate
  // (`teamCreateMetadataError`); a later PATCH would let a session join
  // another session's team.
  'team_lead',
  'workspace_mode',
  'repository_access',
  'repository_generation',
  'sandbox_slug',
  'audit_v2',
] as const;
