import type { ManifestFormat, ResolvedManifest } from '@kortix/manifest-schema';

export type GitTriggerType = 'cron' | 'webhook' | 'monitor' | 'event';

/** For type=monitor only — how the platform runs `run`. */
export type GitMonitorMode = 'poll' | 'stream';

/** For type=event only — which app event on which connector fires the trigger. */
export interface GitTriggerEventFields {
  /** Slug of a connector declared under `connectors:`. */
  connector: string;
  /** Label of one shared account of that connector. Absent = the connector's default shared account. */
  account?: string | null;
  /** Event source adapter id (e.g. `composio`). Absent = the connector's provider. */
  source?: string | null;
  /** The adapter's own event type id (e.g. `GITHUB_PULL_REQUEST_EVENT`). */
  type: string;
  /** Provider event config; the provider validates it at subscribe time. */
  config: Record<string, unknown>;
}

export interface GitTriggerSpec {
  /** URL-safe slug — unique per project. */
  slug: string;
  /**
   * Where the entry is sourced from. Always `<manifest-file>#triggers.<slug>`
   * now that triggers are centralized — `kortix.yaml` for v2 projects,
   * `kortix.toml` for legacy v1 ones. The hash is just a hint for the UI;
   * the platform doesn't use it for routing.
   */
  path: string;
  /** Human label; defaults to the slug when not set. */
  name: string;
  type: GitTriggerType;
  /** Agent name (default: "default"). */
  agent: string;
  /**
   * Model for this trigger's runs (wire form `provider/model`), or null for
   * "Default" — resolve the chain at fire time (agent → project → account →
   * platform `auto`). The most-specific *default-time* override for a trigger
   * run. Catalog-availability is validated at the route layer, not here.
   */
  model: string | null;
  /** When false, the scheduler / webhook receiver skip this entry. */
  enabled: boolean;
  /** Mustache-style prompt template — the body sent to the agent on each fire. */
  promptTemplate: string;
  /** For type=cron only. 6-field croner expression. Null for one-off (`runAt`) schedules. */
  cron: string | null;
  /**
   * For type=cron only. ISO-8601 instant for a one-off ("run once") schedule.
   * Mutually exclusive with `cron`: when set, the trigger fires exactly once
   * at/after this instant and then stays dormant (guarded by last_fired_at).
   */
  runAt: string | null;
  /** For type=cron only. IANA timezone. Defaults to UTC. */
  timezone: string;
  /**
   * For type=webhook only — the project_secrets key that holds the HMAC
   * signing secret. The actual secret value is never inline.
   */
  secretEnv: string | null;
  /**
   * For type=monitor only — the repo-relative command the platform supervises
   * 24/7 in the project's monitor box. Its stdout lines are the events;
   * nothing else is.
   */
  run: string | null;
  /**
   * For type=monitor only. `'poll'` runs `run` every `intervalSeconds` and
   * exits; `'stream'` runs it once and keeps it alive. Downstream (filter →
   * prompt → session_mode) cannot tell the two apart.
   */
  monitorMode: GitMonitorMode | null;
  /** For `monitorMode === 'poll'` only — the poll period, in whole seconds. */
  intervalSeconds: number | null;
  /**
   * For type=monitor only — the silence watchdog. No event within this window
   * synthesizes a `silent` lifecycle event, so a wedged monitor can never fail
   * silently. Null when the monitor declares no expectation.
   */
  expectEventWithinSeconds: number | null;
  /** For type=event only. Absent (or null) for every other type — parsed non-event specs omit it so existing spec shapes are unchanged. */
  event?: GitTriggerEventFields | null;
  /**
   * Session reuse policy.
   * - `'fresh'` (default): every fire mints a brand-new session (new sandbox +
   *   new ephemeral branch) — the historical behavior.
   * - `'reuse'`: re-prompt the most recent session this trigger created
   *   (resuming its sandbox + opencode root) so ONE long-lived session
   *   accumulates context across fires. If no reusable session exists yet (or
   *   the last one is dead/failed), a fresh one is created and becomes the
   *   canonical session going forward. Primarily meant for recurring cron
   *   triggers that should feel like a single persistent agent run.
   * - `'keyed'`: like `'reuse'`, but one canonical session PER `sessionKey`
   *   value instead of one per trigger. The key is a prompt-style template
   *   rendered against the delivery payload, so a single trigger can fan out
   *   into a session per chat / per customer / per repository. This is what
   *   makes a conversational webhook source (WhatsApp, SMS, email) behave like
   *   separate threads rather than one blended transcript.
   */
  sessionMode: GitTriggerSessionMode;
  /**
   * For `sessionMode === 'pinned'` only — the exact `project_sessions.session_id`
   * this trigger loops. Null for `'fresh'`/`'reuse'`. Stored in the manifest as
   * `session_id` (portable) AND persisted on `project_trigger_runtime.session_id`.
   */
  pinnedSessionId: string | null;
  /**
   * For `sessionMode === 'keyed'` only — a `{{ body.path }}` template rendered
   * against the webhook payload to produce the session key (e.g.
   * `"{{ body.data.chat_jid }}"`). Null for every other mode. A fire whose key
   * renders empty degrades to `'fresh'` rather than colliding every keyless
   * delivery into one shared session.
   */
  sessionKey: string | null;
  /**
   * Optional payload guard: dotted paths (rooted at the same `body` / `headers`
   * object the prompt template sees) mapped to the value they must equal for the
   * trigger to fire. A non-matching delivery is accepted (200) and recorded, but
   * spawns no session.
   *
   * The motivating case is loop-breaking: a webhook source that reports BOTH
   * directions of a conversation would otherwise re-trigger the agent with the
   * agent's own reply. `{ "body.data.direction": "inbound" }` ends that without
   * having to narrow the subscription and lose every other event type.
   */
  filter: Record<string, string> | null;
  /**
   * Set only on a session reminder (`lib/session-reminders.ts`): a DB-native `cron`
   * row that re-prompts `pinnedSessionId`. The manifest never declares one, so
   * manifest reconcile skips these rows instead of pruning them.
   */
  reminder?: SessionReminderFields | null;
}

export interface SessionReminderFields {
  /** Recurring period in seconds, or null for a cron or one-shot reminder. */
  everySeconds: number | null;
  createdAt: string;
  /** Set when a person created the reminder, not the session's own agent: a
   *  fire is that person's deferred prompt, so its turn acts as them (the
   *  session token rebinds at delivery, like a queued prompt). Absent for an
   *  agent-created reminder, whose fire leaves the token's identity as is. */
  promptAuthorUserId?: string;
}

export type GitTriggerSessionMode = 'fresh' | 'reuse' | 'pinned' | 'keyed';

export const GIT_TRIGGER_SESSION_MODES: readonly GitTriggerSessionMode[] = [
  'fresh',
  'reuse',
  'pinned',
  'keyed',
];

/**
 * The `session_mode` a trigger gets when it declares none.
 *
 * `'reuse'` for a monitor, `'fresh'` for cron/webhook. A monitor fires
 * repeatedly by design — a live log emits all day — so defaulting it to fresh
 * would mint one session per event.
 */
export function defaultTriggerSessionMode(type: GitTriggerType): GitTriggerSessionMode {
  return type === 'monitor' ? 'reuse' : 'fresh';
}

export interface GitMonitorFields {
  run: string;
  monitorMode: GitMonitorMode;
  intervalSeconds: number | null;
  expectEventWithinSeconds: number | null;
}

export interface GitTriggerParseError {
  slug: string;
  path: string;
  error: string;
}

export interface ParsedManifest {
  schemaVersion: number;
  /** The raw decoded object — callers shouldn't usually need this. */
  raw: Record<string, unknown>;
  /** Which on-disk format this manifest is in. Drives serialization back to the
   *  same format on commit. Required so every construction site is explicit. */
  format: ManifestFormat;
  /** The repo-relative file the manifest was read from (or should be written to
   *  for a synthesized one) — e.g. `kortix.yaml` or `kortix.toml`. Lets the
   *  commit path write to the exact same file, honoring `.yml` and custom dirs. */
  path: string;
  /** Git blob SHA observed with this manifest, or null when the file was absent. */
  revision?: string | null;
  /** Logical manifest files in winner-priority order. */
  candidatePaths?: string[];
  /** Commit the manifest was read at, or null when unknown (synthesized, or
   *  a string parse with no git context). Carried onto derived grants. */
  commit?: string | null;
  /**
   * Set when the manifest declares `imports:`. `raw` is then the MERGED
   * document; this carries every source file (root first) and the file each
   * trigger/connector/agent/app was declared in, so `commitManifest` writes an
   * edit back to the declaring file instead of flattening it into the root.
   */
  imports?: ResolvedManifest;
}

/** Result of `loadProjectTriggers` — same shape callers got pre-refactor. */
export interface LoadedTriggers {
  specs: GitTriggerSpec[];
  errors: GitTriggerParseError[];
}
