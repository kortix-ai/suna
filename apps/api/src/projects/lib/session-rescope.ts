/**
 * Re-scoping a RUNNING session: replace what it may read and reach, from now on.
 *
 * The per-session `secrets` allowlist and `connector_bindings` were create-only.
 * The stated reason — a mutable allowlist "could be narrowed below what the
 * sandbox already needs and leave the session unbootable" — is an argument about
 * BOOT, and it silently became a refusal to change anything at all.
 *
 * It does not survive contact with the machinery. `syncSandboxEnvForPrompt`
 * already re-resolves the whole secret set and REPLACES the sandbox env on every
 * prompt — that is how a revoked secret propagates. A re-scope needs no new
 * delivery path; it needs a place to write the new list.
 *
 * SET semantics, not append: the list supplied replaces the previous one. From
 * the next prompt, the session sees exactly what was named.
 *
 * WHAT THIS DOES AND DOES NOT PROMISE — the distinction is the whole contract:
 *
 *   - Going FORWARD it is exact. The next prompt's env push carries only the new
 *     set; the daemon's env store clears the names it previously knew
 *     (`mergeProjectEnv`), so a shell spawned after the re-scope cannot see a
 *     dropped secret.
 *   - RETROACTIVELY it promises nothing, and must not pretend to. A value the
 *     agent already read is in its context, and in any shell it spawned before
 *     the re-scope. Dropping a secret is "stop handing it out", never "unsay it".
 *
 * Callers must surface that difference. A UI that says "revoked" where the truth
 * is "revoked for anything started from here" is the kind of false assurance that
 * gets a credential left in place.
 */

import {
  canonicalConnectorAlias,
  publicConnectorAlias,
} from '../../shared/connector-alias';

export type RescopeSecretsResult =
  | {
      ok: true;
      allowlist: string[] | null;
      dropped: string[];
      added: string[];
      /**
       * Did the session's effective secret set SHRINK?
       *
       * Not derivable from `dropped.length`, and that is the whole point. A
       * session's allowlist starts `null` — "everything the agent's grant
       * allows" — so its first narrowing is a null → list transition, and the
       * names lost are only enumerable when the grant itself is a list. With an
       * `'all'` grant they are not, yet the narrowing is just as real.
       *
       * Keying the caller's "…rotate them if that matters" warning off
       * `dropped.length` therefore suppressed it on the LARGEST narrowing there
       * is: revoking every secret from a live session reported that nothing had
       * been dropped. Branch on this instead.
       */
      narrowed: boolean;
    }
  | { ok: false; code: 'NOT_IN_AGENT_GRANT'; message: string; offending: string[] };

/**
 * Decide the new allowlist for a session.
 *
 * `requested` is the FULL new list — `['b']` after `['a','b']` means `a` stops
 * being delivered. `null` means "stop narrowing", i.e. fall back to the agent's
 * own grant, which is what an absent allowlist has always meant.
 *
 * `agentGrantEnv` is the ceiling. A re-scope may narrow within the agent's grant
 * and may restore anything inside it, but can never exceed it — the grant is the
 * manifest's statement about what this agent may EVER read, and a session-level
 * field must not be able to widen past it. `undefined`/`'all'` means unrestricted.
 */
export function rescopeSessionSecrets(input: {
  current: string[] | null;
  requested: string[] | null;
  agentGrantEnv: string[] | 'all' | undefined;
}): RescopeSecretsResult {
  const requested = input.requested === null ? null : normalize(input.requested);

  if (requested !== null && Array.isArray(input.agentGrantEnv)) {
    const grant = new Set(input.agentGrantEnv.map((id) => id.toUpperCase()));
    const offending = requested.filter((id) => !grant.has(id.toUpperCase()));
    if (offending.length > 0) {
      return {
        ok: false,
        code: 'NOT_IN_AGENT_GRANT',
        message:
          `not in this agent's secrets grant: ${offending.join(', ')} — a session may narrow ` +
          'within the grant, never past it',
        offending,
      };
    }
  }

  const before = input.current === null ? null : normalize(input.current);
  // A null allowlist means "everything the grant allows". When the grant is a
  // list, that set IS enumerable — so narrowing away from null can name exactly
  // what it dropped, which is the case that previously reported nothing.
  const grantList = Array.isArray(input.agentGrantEnv)
    ? normalize(input.agentGrantEnv)
    : null;
  const effectiveBefore = before ?? grantList;

  const dropped =
    effectiveBefore !== null && requested !== null
      ? effectiveBefore.filter(
          (id) => !requested.some((r) => r.toUpperCase() === id.toUpperCase()),
        )
      : [];
  const added =
    before !== null && requested !== null
      ? requested.filter((id) => !before.some((b) => b.toUpperCase() === id.toUpperCase()))
      : [];

  // Narrowing with UNKNOWABLE names: an `'all'` (or absent) grant going from
  // null to any explicit list. Nothing can be listed, but the warning must
  // still fire — this is the revoke-everything case.
  const narrowedBeyondNames =
    before === null && requested !== null && grantList === null;
  const narrowed = dropped.length > 0 || narrowedBeyondNames;

  return { ok: true, allowlist: requested, dropped, added, narrowed };
}

/** Trim, drop blanks, de-duplicate case-insensitively, keep first spelling. */
function normalize(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) continue;
    const key = id.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

export type RescopeBindingsResult =
  | { ok: true; bindings: Record<string, string>; dropped: string[]; changed: string[] }
  | { ok: false; code: 'NOT_GRANTED_CONNECTOR'; message: string; offending: string[] };

/**
 * Same shape for connector bindings: the map supplied REPLACES the previous one.
 *
 * An alias present before and absent now stops resolving to that connection —
 * it falls back to whatever the session's `inherit_unbound` setting dictates,
 * exactly as an alias that was never bound.
 *
 * Unlike secrets, this one IS retroactively effective: a connector binding is
 * resolved server-side at CALL time, so the next tool call already uses the new
 * map. Nothing about it was ever handed to the sandbox.
 */
export function rescopeSessionBindings(input: {
  current: Record<string, string>;
  requested: Record<string, string>;
  grantedConnectors: string[] | 'all' | undefined;
}): RescopeBindingsResult {
  const current: Record<string, string> = {};
  for (const [alias, connectionId] of Object.entries(input.current)) {
    current[canonicalConnectorAlias(alias.trim())] = connectionId;
  }

  const requested: Record<string, string> = {};
  for (const [alias, connectionId] of Object.entries(input.requested)) {
    const key = canonicalConnectorAlias(alias.trim());
    const value = typeof connectionId === 'string' ? connectionId.trim() : '';
    if (!key || !value) continue;
    requested[key] = value;
  }

  if (Array.isArray(input.grantedConnectors)) {
    const granted = new Set(input.grantedConnectors.map(canonicalConnectorAlias));
    const offending = Object.keys(requested).filter((alias) => !granted.has(alias));
    if (offending.length > 0) {
      return {
        ok: false,
        code: 'NOT_GRANTED_CONNECTOR',
        message:
          `not granted to this agent: ${offending.join(', ')} — binding an alias the manifest ` +
          'does not grant would 403 at the first tool call',
        offending,
      };
    }
  }

  const dropped = Object.keys(current)
    .filter((alias) => !(alias in requested))
    .map(publicConnectorAlias);
  const changed = Object.keys(requested)
    .filter((alias) => alias in current && current[alias] !== requested[alias])
    .map(publicConnectorAlias);
  return { ok: true, bindings: requested, dropped, changed };
}
