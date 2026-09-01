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

/** Regex matching every user-defined slug (triggers, sandboxes, apps, connectors, subprojects). */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * A subproject's source repository, as `owner/repo`. Deliberately NOT a URL: the
 * manifest records provenance in the shortest form that still resolves, and
 * the host is implied (GitHub). The submit API normalizes every URL/SSH/clone
 * form down to this before it is ever written here.
 */
export const SUBPROJECT_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The four entity kinds a subproject can contribute, and therefore the only keys
 * `subprojects[].owns` may carry. Uninstall reads this map to know what to remove,
 * so an unknown key here would silently strand files in the project.
 */
export const SUBPROJECT_OWNED_KINDS = ['agents', 'skills', 'connectors', 'triggers'] as const;
export type SubprojectOwnedKind = (typeof SUBPROJECT_OWNED_KINDS)[number];

/** A subproject's source address, normalized. `ref` is a branch or tag, never a sha. */
export interface SubprojectRepoAddress {
  owner: string;
  repo: string;
  /** The branch/tag the caller pinned, or null for the repo's default branch. */
  ref: string | null;
}

/**
 * Normalize whatever a person pastes into one subproject source address.
 *
 * Accepts a browser URL, an `.git` clone URL, an `ssh://` or `git@` remote, a
 * `github:` scheme, or a bare `owner/repo` — optionally suffixed `@<ref>` to
 * pin a branch or tag. Returns null when the value does not identify exactly
 * one GitHub repository, which is what gates the submit form's Continue.
 *
 * Deliberately GitHub-only and deliberately strict: this value ends up in a
 * committed manifest and in a URL the server fetches, so anything still
 * carrying a scheme, a host, a query, or a path beyond `owner/repo` is
 * rejected rather than coerced. A non-GitHub URL must never pass as
 * `owner/repo`.
 *
 * Shared by the API's submit route and the web submit modal so the two can
 * never disagree about what a person typed.
 */
export function parseSubprojectRepo(value: string): SubprojectRepoAddress | null {
  const raw = value.trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/^git@github\.com:/i, '')
    .replace(/^github:/i, '')
    .replace(/^(?:https?:\/\/|ssh:\/\/git@|git:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');

  // Split a trailing `@ref` BEFORE the `.git` strip, so `owner/repo.git@v1`
  // and `owner/repo@v1` both work. An `@` in the owner position (a scp-style
  // remote we failed to clean) leaves a colon or slash behind and is rejected
  // by the checks further down.
  const at = cleaned.lastIndexOf('@');
  const hasRef = at > 0 && !cleaned.slice(at + 1).includes('/');
  const refRaw = hasRef ? cleaned.slice(at + 1).trim() : '';
  const withoutRef = (hasRef ? cleaned.slice(0, at) : cleaned).replace(/\.git$/i, '');

  // Anything still holding a scheme separator or whitespace is not `owner/repo`.
  if (/[:\s]/.test(withoutRef) || /[:\s]/.test(refRaw)) return null;
  // An absolute path must not survive as `owner/repo`: `/etc/passwd` splits to
  // a leading EMPTY segment that `filter(Boolean)` would silently drop, leaving
  // a plausible-looking `etc/passwd`. Reject the shape before splitting.
  if (withoutRef.startsWith('/')) return null;

  const parts = withoutRef.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  // Reject a doubled separator (`acme//repo`) for the same reason — the empty
  // middle segment vanishes in the filter and two forms would map to one repo.
  if (parts.join('/') !== withoutRef) return null;
  const [owner, repo] = parts;

  const NAME_RE = /^[\w.-]+$/;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  // `.` and `..` are legal against NAME_RE but are not repository names.
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  // A ref may contain slashes upstream (`release/1.x`), but this form cannot
  // express one unambiguously against `owner/repo`, so only simple refs pass.
  if (hasRef && (!refRaw || !NAME_RE.test(refRaw))) return null;

  return { owner, repo, ref: hasRef ? refRaw : null };
}

/** Regex matching every legal env-var name. */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Env-var names the runtime owns, which a manifest may therefore not set.
 *
 * WHY THIS LIVES IN THE MANIFEST SCHEMA
 *
 * The API refuses these when it builds a deployment's environment
 * (`resolveAppRuntimeEnvironment` → `assertDestination`). For a long time the
 * manifest validator did not, so `kortix validate` passed on a manifest that
 * could never deploy, and the author found out from a failed deploy instead of
 * from the tool whose entire job is to tell them first.
 *
 * That is not a hypothetical: a `kortix.yaml` setting `KORTIX_API_KEY`
 * validated clean and failed at deploy, and the App that eventually shipped
 * without those variables did not error at all — the feature depending on them
 * simply rendered nothing.
 *
 * So the rule lives here, in the contract package both sides already depend
 * on, and `apps/api` imports it rather than restating it.
 */
export const RESERVED_ENV_NAME_PREFIXES = ['KORTIX_', 'OPENCODE_'] as const;

/** Process-level names the sandbox sets itself; overriding them breaks boot. */
export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  'PORT',
  'PATH',
  'HOME',
  'PWD',
  'USER',
  'LOGNAME',
  'SHELL',
  'HOSTNAME',
  'TERM',
  'TMPDIR',
  'NODE_ENV',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);

/**
 * Secrets the platform holds but must never hand to a runtime, because an
 * agent reachable by prompt injection would then be holding them too.
 */
export const NEVER_DELIVERED_ENV_NAMES: ReadonlySet<string> = new Set([
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
]);

/** Is this name one the runtime owns? Used by both `validate` and deploy. */
export function isReservedEnvName(name: string): boolean {
  return (
    RESERVED_ENV_NAMES.has(name) ||
    NEVER_DELIVERED_ENV_NAMES.has(name) ||
    RESERVED_ENV_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Why a name is refused, phrased for the person who wrote the manifest. */
export function reservedEnvNameReason(name: string): string | null {
  const prefix = RESERVED_ENV_NAME_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (prefix) {
    return `is reserved: the \`${prefix}\` prefix belongs to the platform. Rename it (for example \`MYAPP_${name.slice(prefix.length)}\`) and read it under the new name.`;
  }
  if (NEVER_DELIVERED_ENV_NAMES.has(name)) {
    return 'is reserved: the platform never delivers this secret to a runtime.';
  }
  if (RESERVED_ENV_NAMES.has(name)) {
    return 'is reserved: the runtime sets this itself, and overriding it breaks the sandbox.';
  }
  return null;
}

export const TRIGGER_TYPES = ['cron', 'webhook', 'monitor'] as const;

/**
 * A `type: monitor` trigger's shape. `poll` runs `run` every `interval` and
 * exits; `stream` runs it once and keeps it alive. Both emit events as stdout
 * lines — downstream (filter → prompt → session_mode) cannot tell them apart.
 * See docs/specs/2026-08-12-monitors.md §"The monitor contract (v1)".
 */
export const MONITOR_MODES = ['poll', 'stream'] as const;

/** Floor for `interval` on a `mode: poll` monitor — the platform bound. */
export const MONITOR_MIN_INTERVAL_SECONDS = 30;
/** Floor for `expect_event_within` (the silence watchdog) — the platform bound. */
export const MONITOR_MIN_EXPECT_EVENT_WITHIN_SECONDS = 300;
/** Longest `run` command accepted. Bounds a hostile manifest out of the box config. */
export const MONITOR_RUN_MAX_LENGTH = 1024;

/**
 * Duration literal accepted by `interval` / `expect_event_within`: a positive
 * integer plus one unit suffix (`30s`, `5m`, `24h`, `7d`). Deliberately not a
 * bare number — "60" reads as either seconds or minutes depending on the
 * reader, and the manifest is a human-review surface.
 */
export const DURATION_RE = /^([1-9][0-9]*)(s|m|h|d)$/;

const DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** Parse a {@link DURATION_RE} literal to whole seconds. Null when malformed. */
export function parseDurationSeconds(raw: string): number | null {
  const match = DURATION_RE.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]) * DURATION_UNIT_SECONDS[match[2]!]!;
}

/**
 * Inverse of {@link parseDurationSeconds}, in the largest unit that divides
 * evenly (`60` → `"1m"`, `86400` → `"1d"`). Canonical, so a spec that
 * round-trips through the CRUD write path emits one stable form — the same
 * normalization `run_at` already gets (parsed, then re-emitted as ISO-8601).
 */
export function formatDurationSeconds(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds <= 0) return `${seconds}s`;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
// Providers a kortix.yaml may declare. `channel` is included because the
// platform itself writes a `connectors:` entry with `provider: channel` into the
// manifest when a Slack/email channel is connected (see connector/channel-manifest.ts), so
// the gate must accept what the backend produces. MUST stay in sync with the
// runtime parser's PROVIDERS in apps/api/src/projects/connectors.ts — enforced
// by apps/api/src/__tests__/unit-connectors-parse.test.ts. `computer` is
// deliberately absent: it is synth-only and never written to a manifest.
export const CONNECTOR_PROVIDERS = [
  'pipedream',
  'composio',
  'mcp',
  'openapi',
  'postman',
  'graphql',
  'http',
  'channel',
] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];
export const CONNECTOR_AUTH_TYPES = [
  'bearer',
  'basic',
  'custom',
  'api_key',
  'oauth1',
  'hmac',
  'aws_sigv4',
  'mtls',
  'none',
] as const;
/** The exclusive owner model for connections under one connector. */
export const CONNECTOR_AUTHORIZATION_STRATEGIES = ['project', 'user'] as const;
/** Platforms a `channel` connector can target — mirrors connectors.ts CHANNEL_PLATFORMS. */
export const CHANNEL_PLATFORMS = ['slack', 'teams', 'email'] as const;
/**
 * Platform-owned slugs and the only provider allowed to use each — mirrors
 * connectors.ts RESERVED_SLUG_PROVIDERS so a user app can't shadow the built-in
 * catalog (the bug that made `slack thread` 404; see KORTIX-206).
 */
export const RESERVED_SLUG_PROVIDERS: Readonly<Record<string, string>> = {
  kortix_slack: 'channel',
  kortix_teams: 'channel',
  kortix_email: 'channel',
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
  'project.delete',
  'project.cr.open',
  'project.cr.merge',
  'project.session.read',
  'project.session.start',
  'project.session.stop',
  'project.session.bindings.write',
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
  'project.connector.connections.manage',
  'project.connector.write',
  'project.app.read',
  'project.app.write',
  'project.app.deploy',
  'project.review.read',
  'project.review.submit',
  'project.review.act',
  // Minting a project credential. Grantable so a manifest CAN hand it to an
  // agent explicitly, but note the two credential routes refuse an
  // agent-session token outright (projects/routes/r3.ts) — an agent that could
  // mint a fresh, grant-less project token would escape its own ceiling. The
  // leaf exists so a CUSTOM ROLE can withhold it from humans.
  'project.credentials.issue',
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

export const V2_RUNTIME_VALUES = ['opencode', 'pi'] as const;
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
