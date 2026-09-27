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
export const SERVER_MANAGED_SESSION_METADATA_KEYS = [
  // Soft delete (`deleteSession`).
  'deletedAt',
  'deletedBy',
  // Model pin (`opencode_model` body field and `PUT …/model`).
  'opencode_model',
  'opencode_model_source',
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
  // Agents as principals (spec 2026-09-22 §2.3): the mint reads these to decide
  // `on_behalf_of`. A client that could set `spawned_by_session` would inherit
  // another session's human; one that could forge the cleared stamp is harmless
  // but still not the client's to write.
  'spawned_by_session',
  'on_behalf_of_cleared_at',
  // Legacy migration restore. Selects the archive that session open and
  // restart copy into the sandbox (`legacy-migration-rehydrate.ts`).
  'legacy_migration',
  // Channel origin. Reply targets and the channel runtime env
  // (`session-channel-env.ts`, the Slack/Teams/email/Telegram relays).
  'slack',
  'teams',
  'email',
  'telegram',
  // Warm-session pool marker (`lib/warm-sessions.ts`).
  'warm',
  // Activity-ordered session list (`session-list.ts` `orderByActivity`). The
  // server stamps conversation activity; a client value would let it fake a
  // sidebar position.
  'last_activity_at',
] as const;

/**
 * PATCH also refuses keys that `POST` stamps unconditionally after the client
 * spread, so on create a client value is overwritten and on update it would
 * persist.
 */
export const PATCH_SERVER_MANAGED_SESSION_METADATA_KEYS = [
  ...SERVER_MANAGED_SESSION_METADATA_KEYS,
  'workspace_mode',
  'repository_access',
  'repository_generation',
  'sandbox_slug',
  'audit_v2',
] as const;
