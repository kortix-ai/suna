import { MID_SESSION_CAPABILITIES } from './mid-session-change';
import type {
  SessionConnectorBindings,
  SessionScope,
  SessionScopeInput as SessionScopeReplacement,
} from '@kortix/sdk';

/**
 * What THIS session is actually scoped to, and what can still move.
 *
 * The scope panel used to print generic prose about the three overrides. Prose
 * cannot answer the question people actually have mid-session — "what can this
 * session read, right now?" — so every row here carries the session's real
 * value, and the "can I change it?" line explains the reason for THIS session
 * rather than restating the rule.
 *
 * Pure: the workbench passes what it read off the session, so the wording can
 * be asserted without a runtime.
 */

export type ScopeRowKey = 'model' | 'agent' | 'secrets' | 'connections';

export interface SessionScopeRow {
  key: ScopeRowKey;
  label: string;
  /** The short "can I change this now?" badge. */
  badge: string;
  /** This session's real state, in one line. null when the row's own control
   *  already shows it — duplicating the model next to the model switcher would
   *  just give the two places to disagree. */
  value: string | null;
  detail: string;
  /** Whether a live control belongs on this row — only the model has one. */
  control: 'model' | null;
}

export interface SessionScopeRowsInput {
  /** `session.agent_name` — null when the workspace default agent runs. */
  agentName: string | null | undefined;
  /** `session.secrets_allowlist` — null/undefined = never narrowed. */
  secretsAllowlist: string[] | null | undefined;
  /** Active connector bindings, alias -> connection label or identifier. */
  boundConnections: Record<string, string>;
}

const ALL_SECRETS = 'Everything the agent is granted';

/** Extract the canonical connection identifiers from a scope response. */
export function readScopeBindingIds(
  bindings: SessionConnectorBindings | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bindings ?? {}).map(([alias, binding]) => [
      alias,
      binding.connection_id,
    ]),
  );
}

export function buildCompleteSessionScopeReplacement(
  current: SessionScope,
  changes: {
    secrets?: string[] | null;
    bindings?: Record<string, string>;
  },
): SessionScopeReplacement {
  const secrets = Object.hasOwn(changes, 'secrets')
    ? changes.secrets
    : current.secrets_allowlist;
  const bindings = Object.hasOwn(changes, 'bindings')
    ? (changes.bindings ?? {})
    : readScopeBindingIds(current.connector_bindings);

  return {
    secrets: secrets === null ? null : [...(secrets ?? [])],
    connector_bindings: Object.fromEntries(
      Object.entries(bindings).map(([alias, connectionId]) => [
        alias,
        { connection_id: connectionId },
      ]),
    ),
  };
}

export function describeSecretsAllowlist(
  allowlist: string[] | null | undefined,
  agentName: string | null | undefined,
): string {
  if (allowlist === null || allowlist === undefined) {
    return agentName ? `Everything ${agentName} is granted` : ALL_SECRETS;
  }
  // `secrets: []` is a deliberate choice, not an empty state — saying "none"
  // where the UI says "all" for null is the whole point of the distinction.
  if (allowlist.length === 0) return 'No workspace secrets';
  return allowlist.join(', ');
}

export function sessionScopeRows(
  input: SessionScopeRowsInput,
): SessionScopeRow[] {
  const agent = input.agentName ?? null;
  const agentLabel = agent ?? 'The workspace default agent';
  const bound = Object.entries(input.boundConnections);

  return [
    {
      key: 'model',
      label: 'Model',
      badge: 'Changeable now',
      value: null,
      detail:
        'Switching restarts the runtime, which ends the in-flight turn. If it cannot be applied live the change is saved and takes effect the next time this session starts — the switcher says which happened.',
      control: 'model',
    },
    {
      key: 'agent',
      label: 'Agent',
      badge: 'Per message',
      value: agentLabel,
      detail: agent
        ? `Messages run as ${agent} unless another agent is picked in the composer. A switch re-scopes future secret delivery, connector access, and Kortix CLI access to the selected agent.`
        : "Messages run as the workspace's default agent unless another is picked in the composer. A switch re-scopes future secret delivery, connector access, and Kortix CLI access to the selected agent.",
      control: null,
    },
    {
      key: 'secrets',
      label: 'Secrets',
      badge: 'Changeable now',
      value: describeSecretsAllowlist(input.secretsAllowlist, agent),
      detail:
        input.secretsAllowlist === null || input.secretsAllowlist === undefined
          ? 'No narrower allowlist was set, so this session gets the agent’s full secret grant. Set one from the scope bar under the composer — what you send REPLACES the list, from the next prompt.'
          : 'Change it from the scope bar under the composer. What you send REPLACES this list, from the next prompt. Removing one stops it being handed out, but cannot un-read a value the agent already has — rotate the secret if you need it truly revoked.',
      control: null,
    },
    {
      key: 'connections',
      label: 'Connections',
      badge: 'Changeable now',
      value:
        bound.length === 0
          ? 'The workspace default for every connector'
          : bound.map(([alias, label]) => `${alias}: ${label}`).join(', '),
      detail:
        bound.length === 0
          ? 'Every connector this agent uses resolves to the workspace’s default connection. Bind a specific workspace connection from the scope bar.'
          : 'Change these from the scope bar under the composer. Unlike secrets a binding change is fully retroactive — connections resolve server-side on each tool call, so the next call already uses the new one. Only workspace connections can be bound, never a teammate’s private one.',
      control: null,
    },
  ];
}

/** The scope rows the mid-session capability map says are frozen. Keeps the
 *  badges from drifting away from the contract they describe. */
export function isFixedAtStart(
  key: keyof typeof MID_SESSION_CAPABILITIES,
): boolean {
  // Derived from the capability table, with no hardcoded exception. `connections`
  // used to be forced true here even though the table had no entry for it — so
  // the badge and the behaviour could disagree, and did the moment the /scope
  // route made bindings changeable.
  //
  // Typed on the TABLE's keys, not ScopeRowKey: every scope-bar row is now
  // changeable, so narrowing the parameter to those four would make this
  // provably always-false and the compiler would (rightly) reject the
  // comparison. `runtime_context` is the one still-frozen field.
  return MID_SESSION_CAPABILITIES[key] === 'fixed_at_create';
}

/**
 * Is this session's scope safe to RENDER as fact?
 *
 * A redacted session arrives as a perfectly good HTTP 200: the serializer blanks
 * an inaccessible row to `metadata: {}` and `secrets_allowlist: null`, and
 * `null` is exactly what `sessionScopeRows` reads as "everything the agent grant
 * allows". So a session the caller may NOT open would render as LESS restricted
 * than one they may — a redaction turned into a false reassurance.
 *
 * Lives here rather than inline in the component so it can be tested: the panel
 * is prose about what a session may reach, and prose that is wrong is worse than
 * absent.
 */
export function sessionScopeIsReadable<T extends { can_access?: boolean }>(
  session: T | null | undefined,
): session is T {
  if (!session) return false;
  // Only an explicit false hides it. `undefined` means the field was not
  // serialized for this shape at all, which is the ordinary accessible case.
  return session.can_access !== false;
}
