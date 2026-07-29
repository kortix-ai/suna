/**
 * What the bar under the composer may SAY, and what it may DO.
 *
 * The scope controls belong next to the input, not in a dialog someone saw once
 * before the session existed — "which secrets can this thing read?" is asked
 * mid-conversation. But two of the four answers are written exactly once, at
 * create (`mid-session-change.ts`), so the bar has to be able to tell an
 * editable control from a decorative one BEFORE it renders either. A control
 * that appears to re-scope a running session — and silently doesn't — is worse
 * than no bar at all, so that judgement lives here, in a pure module, where it
 * can be asserted.
 *
 * Everything else here is presentation the copy depends on being right about:
 * which secrets are in and which are out, which identifiers the allowlist names
 * that no longer exist, and why an alias with connections still has nothing to
 * bind.
 */

import { type ConnectorBindingNotice, connectorBindingNotice } from '@/lib/connector-binding';
import { collidingIdentifiers, normalizeSecretKey } from '@/lib/secret-collisions';
import { isAllowlistable } from '@/lib/secret-scope';
import { type ScopeRowKey, isFixedAtStart } from '@/lib/session-scope';
import type {
  BindableConnection,
  ConnectorBindingChoice,
  ConnectorBindingUnavailable,
} from '@/server/bindable-connections';
import type { ProjectSecret } from '@kortix/sdk';

// ── Which controls may touch THIS session ───────────────────────────────────

/** Same four rows the scope panel names, so the two cannot disagree. */
export type ScopeControlKey = ScopeRowKey;

export interface ScopeControl {
  key: ScopeControlKey;
  /** Does a control here change the RUNNING session, or only the next one? */
  live: boolean;
  badge: string;
  note: string;
}

const COPY: Record<ScopeControlKey, { badge: string; note: string }> = {
  model: {
    badge: 'Changeable now',
    note: 'Switching re-points the running runtime, which restarts it and ends the in-flight turn. If it cannot be applied to the running box the choice is saved and takes effect the next time this session starts — the picker says which happened.',
  },
  agent: {
    badge: 'Per message',
    note: 'Each message names the agent that runs it, and the composer above picks it. An agent whose SECRET access differs from the one this session booted with is refused — only a new session can run it.',
  },
  secrets: {
    badge: 'Changeable',
    note: 'What you set REPLACES the current list, from the next prompt. Dropping one stops it being delivered — it cannot un-read a value the agent already has in its context or in a shell it already started, so rotate it if that matters.',
  },
  connections: {
    badge: 'Changeable',
    note: 'What you set REPLACES the current bindings. Unlike secrets this is fully retroactive — a binding is resolved server-side on each tool call, so the next call already uses the new one. An alias you unbind falls back to the project default.',
  },
};

export function scopeControl(key: ScopeControlKey): ScopeControl {
  return { key, live: !isFixedAtStart(key), ...COPY[key] };
}

/**
 * The only honest action a create-only row can offer.
 *
 * Not "apply", not "save": nothing on a running session accepts either, so the
 * button has to name what actually happens.
 */
export const START_NEW_SESSION_ACTION = 'Start a new session with this scope';

// ── Secrets ─────────────────────────────────────────────────────────────────

/**
 * `agent_grant` is not "allowed" with a nicer name: a session that started
 * WITHOUT an allowlist reads whatever its agent is granted, which is a set this
 * app cannot enumerate and may be smaller than the rows shown. Saying "allowed"
 * there would be a claim about secret access that nothing verified.
 */
export type SecretMembership = 'allowed' | 'excluded' | 'agent_grant';

export const SECRET_MEMBERSHIP_LABEL: Record<SecretMembership, string> = {
  allowed: 'Allowed',
  excluded: 'Excluded',
  agent_grant: 'Agent grant',
};

export interface ScopeBarSecretRow {
  /** What the allowlist addresses. Unique per project. */
  identifier: string;
  /** The env KEY the value lands on. Deliberately NOT unique. */
  name: string;
  membership: SecretMembership;
}

export interface ScopeBarSecrets {
  /** Did this session start with an allowlist at all? */
  narrowed: boolean;
  rows: ScopeBarSecretRow[];
  /** Allowlisted identifiers with no project secret behind them. */
  missing: string[];
  /** Chip text — short enough to sit under the composer. */
  summary: string;
  detail: string;
}

export const MISSING_SECRET_NOTE =
  'Named in this session’s allowlist but not a project secret now — it was removed, or it never existed.';

export function scopeBarSecrets(input: {
  secrets: ProjectSecret[] | undefined;
  /** `session.secrets_allowlist`. null/undefined = never narrowed. */
  allowlist: string[] | null | undefined;
}): ScopeBarSecrets {
  const allowlist = input.allowlist ?? null;
  const narrowed = allowlist !== null;
  const allowed = new Set(allowlist ?? []);

  // Only runtime-scoped rows can be named at all — create resolves the
  // allowlist against those alone, so listing a channel-install row as
  // "excluded" would invent a decision nobody could have made.
  const rows: ScopeBarSecretRow[] = (input.secrets ?? [])
    .filter(isAllowlistable)
    .map((secret) => ({
      identifier: secret.identifier,
      name: secret.name,
      membership: narrowed
        ? allowed.has(secret.identifier)
          ? 'allowed'
          : 'excluded'
        : 'agent_grant',
    }));

  // Allowlistable rows only. Keying this on EVERY row made an allowlisted-but-
  // unallowlistable identifier count as "known", so it disappeared from the
  // popover while still being counted in the chip summary — the silent
  // disappearance `missing` exists to prevent. It cannot be in a live allowlist
  // legitimately anyway: create would have refused it.
  const known = new Set(
    (input.secrets ?? []).filter(isAllowlistable).map((secret) => secret.identifier),
  );
  const missing = (allowlist ?? []).filter((identifier) => !known.has(identifier));

  if (!narrowed) {
    return {
      narrowed,
      rows,
      missing,
      summary: 'Agent grant',
      detail:
        'This session started without an allowlist, so it reads whatever its agent is granted — which can be fewer of these than the list suggests.',
    };
  }
  if (allowed.size === 0) {
    return {
      narrowed,
      rows,
      missing,
      summary: 'None',
      detail:
        'This session started with an empty allowlist, which is a real choice and not an empty state: it receives no project secrets at all.',
    };
  }
  return {
    narrowed,
    rows,
    missing,
    summary: `${allowed.size} allowed`,
    detail:
      'The allowlist names IDENTIFIERS. The env KEY beside each one is what the value lands on, and two identifiers may legally share a KEY.',
  };
}

// ── The draft carried into the next session ─────────────────────────────────

export type ScopeDraftIssueKind = 'not_created' | 'key_collision';

/** A drafted allowlist entry that would make the create fail, named before it does. */
export interface ScopeDraftIssue {
  identifier: string;
  kind: ScopeDraftIssueKind;
  /** For a collision, the other drafted identifiers writing the same env KEY. */
  conflicts: string[];
  message: string;
}

export const NEW_IDENTIFIER_HINT =
  'You can name an identifier that does not exist yet, but a session cannot create one: add it in Settings → Secrets first, then start a session that allows it. A start that names a missing identifier is refused.';

/**
 * Both ways a drafted allowlist gets refused, checked here rather than
 * discovered at the create.
 *
 * `not_created` is 404 SECRET_IDENTIFIER_NOT_FOUND and `key_collision` is 409
 * SECRET_IDENTIFIER_KEY_COLLISION — and neither is fixable afterwards, because
 * an allowlist cannot be edited once written. So the bar refuses to start
 * rather than starting something that cannot boot.
 */
export function scopeDraftIssues(
  draft: string[],
  secrets: ProjectSecret[] | undefined,
): ScopeDraftIssue[] {
  // Allowlistable rows ONLY. Create resolves the allowlist against runtime-scoped
  // secrets alone, so a channel-install row is not a candidate — judging the
  // draft against every row let an unallowlistable identifier read as "exists",
  // left the start button enabled, and produced a guaranteed
  // 404 SECRET_IDENTIFIER_NOT_FOUND. This module exists to pre-empt exactly that
  // refusal, so it is the one place the filter must not be skipped.
  const items = (secrets ?? []).filter(isAllowlistable);
  const drafted = new Set(draft);
  const issues: ScopeDraftIssue[] = [];

  for (const identifier of draft) {
    const row = items.find((secret) => secret.identifier === identifier);
    if (!row) {
      issues.push({
        identifier,
        kind: 'not_created',
        conflicts: [],
        message: `${identifier} is not a project secret yet. Create it in Settings → Secrets, then start a session that allows it.`,
      });
      continue;
    }
    const conflicts = collidingIdentifiers(items, identifier).filter((other) =>
      drafted.has(other),
    );
    if (conflicts.length > 0) {
      issues.push({
        identifier,
        kind: 'key_collision',
        conflicts,
        message: `${identifier} and ${conflicts.join(', ')} all write ${normalizeSecretKey(row.name)}. One session can carry only one of them.`,
      });
    }
  }
  return issues;
}

export type TypedIdentifier =
  | { kind: 'empty' }
  | { kind: 'already_listed'; identifier: string }
  | { kind: 'existing'; identifier: string }
  | { kind: 'unknown'; identifier: string };

/** What the "add an identifier" field is looking at right now. */
export function classifyTypedIdentifier(
  text: string,
  input: { secrets: ProjectSecret[] | undefined; draft: string[] },
): TypedIdentifier {
  const identifier = text.trim();
  if (identifier.length === 0) return { kind: 'empty' };
  if (input.draft.includes(identifier)) return { kind: 'already_listed', identifier };
  // Same filter as scopeDraftIssues: "exists" here must mean "can be allowed",
  // otherwise the field tells the user an identifier is fine and create 404s.
  const exists = (input.secrets ?? [])
    .filter(isAllowlistable)
    .some((secret) => secret.identifier === identifier);
  return exists ? { kind: 'existing', identifier } : { kind: 'unknown', identifier };
}

// ── Connections ─────────────────────────────────────────────────────────────

export interface ScopeBarConnector {
  alias: string;
  /** What THIS session is bound to — the label recorded at create. null = the project default. */
  bound: string | null;
  /** What a NEW session could bind for this alias. */
  choices: BindableConnection[];
  unavailable: ConnectorBindingUnavailable | null;
  /** The remedy when nothing is bindable. Always a teammate — never "connect it yourself". */
  notice: ConnectorBindingNotice | null;
}

export interface ScopeBarConnectors {
  rows: ScopeBarConnector[];
  summary: string;
}

/**
 * Every alias worth a row: the ones the project has connections for, plus any
 * this session is bound to.
 *
 * The second half matters. A session bound to a connection that has since been
 * revoked disappears from the choices list entirely, and dropping the row would
 * quietly claim the session runs on the project default — which it does not.
 */
export function scopeBarConnectors(input: {
  choices: ConnectorBindingChoice[] | undefined;
  /** Alias -> label, as this wrapper recorded it at create. */
  boundConnections: Record<string, string>;
}): ScopeBarConnectors {
  const choices = input.choices ?? [];
  const aliases = [
    ...new Set([...choices.map((choice) => choice.alias), ...Object.keys(input.boundConnections)]),
  ].sort((a, b) => a.localeCompare(b));

  const rows: ScopeBarConnector[] = aliases.map((alias) => {
    const choice = choices.find((candidate) => candidate.alias === alias) ?? null;
    return {
      alias,
      bound: input.boundConnections[alias] ?? null,
      choices: choice?.connections ?? [],
      unavailable: choice?.unavailable ?? null,
      // Only ask for a notice when the server actually reported a reason.
      // A synthesized row (bound, but no longer in the choices) has no reason,
      // and `connectorBindingNotice` would fall through to "private only" —
      // naming a cause nobody established.
      notice: choice && choice.unavailable !== null ? connectorBindingNotice(choice) : null,
    };
  });

  const bound = rows.filter((row) => row.bound !== null).length;
  const summary =
    rows.length === 0 ? 'None' : bound === 0 ? 'Project defaults' : `${bound} bound`;
  return { rows, summary };
}

/**
 * The bindings to pre-fill the next session with, recovered from the labels
 * this session recorded.
 *
 * The platform never serializes a session's `connector_bindings` back, so the
 * label in metadata is all there is. An alias whose label no longer resolves to
 * a bindable connection is simply left out — which lands it on the project
 * default, exactly where an unbindable alias would end up anyway.
 */
export function seedBindingsFromLabels(rows: ScopeBarConnector[]): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const row of rows) {
    if (row.bound === null) continue;
    const match = row.choices.find(
      // `buildSessionCreateInput` records the profile id when no label was
      // known, so accept either form.
      (connection) => connection.label === row.bound || connection.profileId === row.bound,
    );
    if (match) bindings[row.alias] = match.profileId;
  }
  return bindings;
}
