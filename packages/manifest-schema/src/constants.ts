/**
 * Shared enums/regexes/catalogs used by BOTH the imperative validator
 * (`./index.ts`) and the JSON Schema generator (`./json-schema.ts`) — pulled
 * out into their own dependency-free module so neither of those two needs to
 * import the other (a `index.ts` ⇄ `json-schema.ts` cycle broke bun's
 * bundler: circular top-level `const` access threw "Cannot access before
 * initialization"). `index.ts` re-exports everything here for backward
 * compatibility with existing consumers of `@kortix/manifest-schema`.
 */

/** The slug reserved for the platform-shared default sandbox template. */
export const RESERVED_SANDBOX_SLUG = 'default';

/** Regex matching every user-defined slug (triggers, sandboxes, apps, connectors). */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Regex matching every legal env-var name. */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export const TRIGGER_TYPES = ['cron', 'webhook'] as const;
// Providers a kortix.yaml may declare. `channel` is included because the
// platform itself writes a `connectors:` entry with `provider: channel` into the
// manifest when a Slack/email channel is connected (see executor/channel-manifest.ts), so
// the gate must accept what the backend produces. MUST stay in sync with the
// runtime parser's PROVIDERS in apps/api/src/projects/connectors.ts — enforced
// by apps/api/src/__tests__/unit-connectors-parse.test.ts. `computer` is
// deliberately absent: it is synth-only and never written to a manifest.
export const CONNECTOR_PROVIDERS = ['pipedream', 'mcp', 'openapi', 'graphql', 'http', 'channel'] as const;
export const CONNECTOR_AUTH_TYPES = ['bearer', 'basic', 'custom', 'oauth1', 'none'] as const;
/** Platforms a `channel` connector can target — mirrors connectors.ts CHANNEL_PLATFORMS. */
export const CHANNEL_PLATFORMS = ['slack', 'teams', 'email', 'meet'] as const;
/**
 * Platform-owned slugs and the only provider allowed to use each — mirrors
 * connectors.ts RESERVED_SLUG_PROVIDERS so a user app can't shadow the built-in
 * catalog (the bug that made `slack thread` 404; see KORTIX-206).
 */
export const RESERVED_SLUG_PROVIDERS: Readonly<Record<string, string>> = {
  kortix_slack: 'channel',
  kortix_teams: 'channel',
  kortix_email: 'channel',
  kortix_meet: 'channel',
  computer: 'computer',
};
export const CONNECTOR_POLICY_ACTIONS = ['always_run', 'require_approval', 'block'] as const;

export const SANDBOX_CPU_BOUNDS = { min: 1, max: 32 } as const;
export const SANDBOX_MEMORY_BOUNDS = { min: 1, max: 128 } as const;
export const SANDBOX_DISK_BOUNDS = { min: 1, max: 500 } as const;

/**
 * The actions an agent's `[[agents]].kortix_cli` may grant — the project-scoped
 * surface. MUST stay in sync with apps/api/src/iam/actions.ts PROJECT_ACTIONS —
 * every project-scoped action, including the manager-tier leaves
 * (`project.delete`, `project.members.manage`, `project.gateway.keys.manage`):
 * these are still reachable via a project's `manager` role, so an agent can be
 * granted them too.
 *
 * Account-scoped admin actions (member.*, billing.*, token.*, project.create, …)
 * are excluded here — but omission from this list is NOT the mechanism
 * that keeps an agent off them. The actual enforcement is that every
 * agent-session token is project-scoped (`account_tokens.project_id`):
 * apps/api's IAM v2 engine (`iam/engine-v2.ts`'s `computeTokenScope`) refuses
 * ANY account-scope action outright for a project-bound token — BEFORE the
 * agent's `kortix_cli` grant is even loaded or consulted. This list is a
 * curation/UX surface (what the CLI/dashboard editor OFFER as grantable, and
 * what `validateGrantList` flags as a bad `kortix_cli` entry), not the
 * security boundary itself — grant-omission alone would not stop a
 * hypothetical non-project-scoped token from calling an account action.
 *
 * The channel.* resource actions (channel.send, …) and the
 * project.gateway.routing.edit / project.session.exec / project.schedule.* /
 * project.webhook.* leaves were removed from the catalog (IAM enforcement
 * audit, 2026-07): none of them were ever asserted on any route, so granting
 * or omitting them was a silent no-op.
 */
// MUST stay in sync with apps/api iam/actions.ts GRANTABLE_KORTIX_CLI (=
// Object.values(PROJECT_ACTIONS)). The unit-agents-parse drift-guard test
// fails loudly if these diverge (this package can't import apps/api).
export const GRANTABLE_KORTIX_CLI_ACTIONS: readonly string[] = [
  'project.read',
  'project.write',
  'project.deploy',
  'project.delete',
  'project.cr.open',
  'project.cr.merge',
  'project.session.read',
  'project.session.start',
  'project.session.stop',
  'project.members.read',
  'project.members.manage',
  'project.trigger.read',
  'project.trigger.create',
  'project.trigger.update',
  'project.trigger.delete',
  'project.trigger.fire',
  'project.gateway.logs.read',
  'project.gateway.spend.read',
  'project.gateway.budget.set',
  'project.gateway.keys.manage',
  // IAM v1 per-capability leaves.
  'project.agent.read',
  'project.agent.write',
  'project.skill.read',
  'project.skill.write',
  'project.command.read',
  'project.command.write',
  'project.file.read',
  'project.file.write',
  'project.customize.read',
  'project.customize.write',
  'project.gitops.read',
  'project.gitops.push',
  'project.gitops.merge',
  'project.secret.read',
  'project.secret.write',
  'project.connector.read',
  'project.connector.write',
  'project.review.read',
  'project.review.submit',
  'project.review.act',
];

/**
 * Actions removed from the enforcement catalog (IAM dead-catalog cleanup,
 * 2026-07) but that older project manifests may still list under
 * `kortix_cli`. None of them were ever asserted on any route, so granting or
 * omitting them was always a no-op — but a manifest merge/ship must not start
 * hard-failing for projects that happen to still mention one. Kept out of
 * `GRANTABLE_KORTIX_CLI_ACTIONS` (they must never appear in the role editor
 * or be recommended for new manifests) and instead surfaced as a
 * deprecation warning by `validateGrantList`.
 */
export const LEGACY_TOLERATED_KORTIX_CLI_ACTIONS: readonly string[] = [
  'project.session.exec',
  'project.gateway.routing.edit',
  'project.schedule.read',
  'project.schedule.write',
  'project.webhook.read',
  'project.webhook.write',
  'channel.read',
  'channel.connect',
  'channel.send',
  'channel.disconnect',
];

/**
 * Legacy singular `[sandbox]` image-definition keys — the shape used before
 * images moved under `[[sandbox.templates]]`. Shared by the imperative
 * validator (`./index.ts` `rejectLegacySandbox`, which hard-errors on any of
 * these set directly on `[sandbox]`) and the JSON Schema (`./json-schema.ts`
 * `sandboxSchema`, which forbids them via `additionalProperties`-style
 * per-key `false`) so the two can't drift on which keys are legacy.
 */
export const LEGACY_SANDBOX_KEYS = [
  'image',
  'dockerfile',
  'slug',
  'cpu',
  'memory',
  'disk',
  'entrypoint',
  'context',
  'context_dir',
  'gpu',
] as const;

export const V2_RUNTIME_VALUES = ['opencode'] as const;
export const AGENT_MODES_V2 = ['primary', 'subagent', 'all'] as const;
export const WORKSPACE_MODES_V2 = ['runtime', 'read', 'branch'] as const;
export const PERMISSION_ACTIONS_V2 = ['ask', 'allow', 'deny'] as const;
/** Keys that only ever take a bare action (no glob-map form) — mirrors upstream. */
export const PERMISSION_ACTION_ONLY_KEYS_V2 = [
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'doom_loop',
] as const;
export const AGENT_THEME_COLORS_V2 = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
] as const;
export const HEX_COLOR_RE_V2 = /^#[0-9a-fA-F]{6}$/;
