/**
 * Secret Delivery Strategy — the pure policy layer.
 *
 * Today every project secret an agent is granted is written into its sandbox's
 * process environment, where the agent (which has passwordless root, and runs as
 * the same uid as the daemon) can read it with `env`. Narrowing WHICH secrets
 * are injected is already solved — the agent grant, the per-session allowlist
 * and the reserved-name filter all compose as pure intersections. What has never
 * existed is a way to say a secret should not be injected AT ALL.
 *
 * This module owns that axis and nothing else: given a secret's declared
 * strategy, what may reach the box. It is deliberately DB-free and I/O-free so
 * the decisions can be tested exhaustively, in the same spirit as
 * `resolveGrantedSecretEnv` and `secret-grant.ts`.
 *
 * See docs/SECRET_DELIVERY_STRATEGY_PLAN.md for the whole design, and
 * docs/ENV_SECRET_EXPOSURE_BASELINE.md for the measured behaviour it changes.
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * How a secret's value reaches the wire.
 *
 * - `runtime` — plaintext into the sandbox env. Today's behaviour, and the
 *   default, so nothing changes for an existing project until someone opts in.
 * - `egress`  — a format-shaped handle goes in the box; a dosco proxy OUTSIDE
 *   the guest swaps it for the real value on a matching outbound request.
 * - `broker`  — the value never leaves the server; the agent reaches the
 *   upstream through a named dosco chokepoint.
 * - `denied`  — nothing is emitted; the name does not even appear.
 */
export type SecretStrategy = 'runtime' | 'egress' | 'broker' | 'denied';

/**
 * Strictness, low to high. Composition takes the MAX, so no layer can ever
 * weaken another: a manifest, an agent grant and a session allowlist may each
 * tighten a secret's delivery, none may loosen it.
 */
export const STRATEGY_RANK: Record<SecretStrategy, number> = {
  runtime: 0,
  egress: 1,
  broker: 2,
  denied: 3,
};

export function isSecretStrategy(value: unknown): value is SecretStrategy {
  return typeof value === 'string' && value in STRATEGY_RANK;
}

/**
 * The strictest of the declarations supplied.
 *
 * `undefined`/`null` entries mean "no opinion" and are SKIPPED — they are not
 * `runtime`. This distinction is the whole reason the change is back-compatible:
 * a manifest that lists a secret as a bare string (today's only form) expresses
 * no delivery opinion, so it must not drag a brokered row back down to rank 0.
 */
export function maxStrategy(...declared: Array<SecretStrategy | null | undefined>): SecretStrategy {
  let winner: SecretStrategy = 'runtime';
  let seen = false;
  for (const candidate of declared) {
    if (!isSecretStrategy(candidate)) continue;
    if (!seen || STRATEGY_RANK[candidate] > STRATEGY_RANK[winner]) winner = candidate;
    seen = true;
  }
  return winner;
}

/** True when the secret's plaintext may be written into the sandbox env. */
export function deliversPlaintextToSandbox(strategy: SecretStrategy): boolean {
  return strategy === 'runtime';
}

/** True when the name should not appear in the sandbox at all — not even as a
 *  handle, and not in `KORTIX_PROJECT_SECRET_NAMES`. */
export function isFullyWithheld(strategy: SecretStrategy): boolean {
  return strategy === 'denied';
}

// ── Egress policy ───────────────────────────────────────────────────────────

/**
 * The policy shape lives in `@kortix/db` because it is a STORED document
 * (`project_secrets.egress_policy`, and frozen into `policy_snapshot` on every
 * handle). Declaring a second copy here is how the two drift: a row can outlive
 * the code that wrote it, so the parser and the column must agree by
 * construction rather than by review.
 */
import type { SecretEgressPolicy, SecretEgressRule, SecretInjectionSlot } from '@kortix/db';
import type { SecretConsumer } from '@kortix/api-contract';

export type { SecretConsumer, SecretEgressPolicy, SecretEgressRule, SecretInjectionSlot };

export type EgressPolicyParse =
  { ok: true; policy: SecretEgressPolicy } | { ok: false; error: string };

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_JSON_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Validate a host pattern.
 *
 * Only two shapes are accepted: an exact host, or `*.` plus a host. Regexes and
 * multi-label wildcards are refused deliberately — a matcher a human cannot
 * eyeball is a matcher that will eventually send a credential somewhere
 * unintended, and the failure is silent.
 */
function validHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase();
  if (!host || host.length > 253) return null;
  const body = host.startsWith('*.') ? host.slice(2) : host;
  if (!body || body.startsWith('.') || body.endsWith('.')) return null;
  const labels = body.split('.');
  if (labels.length < 2) return null;
  return labels.every((l) => HOST_LABEL.test(l)) ? host : null;
}

function parseInjectionSlot(input: unknown): SecretInjectionSlot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (raw.kind === 'header') {
    const name = typeof raw.name === 'string' ? raw.name.trim().toLowerCase() : '';
    if (!name || name.length > 128 || !HEADER_NAME.test(name)) return null;
    if (raw.template !== undefined) {
      if (
        typeof raw.template !== 'string' ||
        raw.template.length > 1024 ||
        !raw.template.includes('{{secret}}') ||
        raw.template.includes('\r') ||
        raw.template.includes('\n')
      ) {
        return null;
      }
    }
    return {
      kind: 'header',
      name,
      ...(typeof raw.template === 'string' ? { template: raw.template } : {}),
    };
  }
  if (raw.kind === 'query') {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    return name && name.length <= 128 ? { kind: 'query', name } : null;
  }
  if (raw.kind === 'json_body_field') {
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    const segments = path.split('.');
    if (
      !path ||
      path.length > 512 ||
      segments.length > 16 ||
      segments.some((segment) => !segment || BLOCKED_JSON_SEGMENTS.has(segment))
    ) {
      return null;
    }
    return { kind: 'json_body_field', path };
  }
  return null;
}

export function parseEgressPolicy(input: unknown): EgressPolicyParse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'policy must be an object' };
  }
  const raw = input as Record<string, unknown>;

  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    return { ok: false, error: 'policy.rules must be a non-empty array' };
  }
  const rules: SecretEgressRule[] = [];
  for (const entry of raw.rules) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'each rule must be an object' };
    }
    const r = entry as Record<string, unknown>;
    const host = validHost(r.host);
    if (!host) return { ok: false, error: `invalid rule host: ${String(r.host)}` };

    let methods: string[] | undefined;
    if (r.methods !== undefined) {
      if (!Array.isArray(r.methods)) return { ok: false, error: 'rule.methods must be an array' };
      methods = [];
      for (const m of r.methods) {
        const upper = typeof m === 'string' ? m.trim().toUpperCase() : '';
        if (!HTTP_METHODS.has(upper)) return { ok: false, error: `invalid method: ${String(m)}` };
        methods.push(upper);
      }
    }

    let path: string | undefined;
    if (r.path !== undefined) {
      if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
        return { ok: false, error: 'rule.path must start with /' };
      }
      // One trailing /* only. An embedded * would be a glob nobody can audit.
      const withoutTail = r.path.endsWith('/*') ? r.path.slice(0, -2) : r.path;
      if (withoutTail.includes('*')) {
        return { ok: false, error: 'rule.path allows only one trailing /*' };
      }
      path = r.path;
    }

    let inject: SecretInjectionSlot | undefined;
    if (r.inject !== undefined) {
      inject = parseInjectionSlot(r.inject) ?? undefined;
      if (!inject) return { ok: false, error: 'invalid rule injection' };
    }

    rules.push({
      host,
      ...(methods ? { methods } : {}),
      ...(path ? { path } : {}),
      ...(inject ? { inject } : {}),
    });
  }

  const inject = parseInjectionSlot(raw.inject);
  if (!inject) return { ok: false, error: 'policy.inject is invalid' };

  const backend = raw.backend;
  if (
    backend !== undefined &&
    !['llm_gateway', 'connector', 'git_proxy', 'kortix_fetch'].includes(String(backend))
  ) {
    return { ok: false, error: `unknown backend: ${String(backend)}` };
  }
  if (raw.on_no_match !== undefined && raw.on_no_match !== 'deny') {
    return { ok: false, error: 'policy.on_no_match must be deny' };
  }
  if (raw.tls !== undefined && !['terminate', 'tunnel'].includes(String(raw.tls))) {
    return { ok: false, error: `unknown tls mode: ${String(raw.tls)}` };
  }

  return {
    ok: true,
    policy: {
      rules,
      inject,
      ...(backend ? { backend: backend as SecretEgressPolicy['backend'] } : {}),
      ...(typeof raw.base_url_env === 'string' ? { base_url_env: raw.base_url_env } : {}),
      ...(raw.on_no_match === 'deny' ? { on_no_match: 'deny' as const } : {}),
      ...(raw.tls === 'terminate' || raw.tls === 'tunnel' ? { tls: raw.tls } : {}),
    },
  };
}

export interface OutboundRequestShape {
  host: string;
  method: string;
  path: string;
}

function hostMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith('*.')) return pattern === host;
  const suffix = pattern.slice(1); // ".example.com"
  // A single wildcard label: `*.a.com` matches `b.a.com`, NOT `a.com` itself and
  // NOT `evil-a.com`. Requiring the dot is what stops
  // `api.anthropic.com.attacker.tld` from satisfying `*.anthropic.com`.
  return host.endsWith(suffix) && host.length > suffix.length;
}

function pathMatches(pattern: string | undefined, path: string): boolean {
  if (!pattern) return true;
  if (!pattern.endsWith('/*')) return pattern === path;
  const prefix = pattern.slice(0, -1); // keep the trailing slash
  return path === pattern.slice(0, -2) || path.startsWith(prefix);
}

/**
 * First matching rule wins; NO match is a DENY.
 *
 * Fail-closed is the only defensible default here: the alternative sends a live
 * credential to a host nobody declared.
 */
export function matchRule(
  policy: SecretEgressPolicy,
  request: OutboundRequestShape,
): SecretEgressRule | null {
  const host = request.host.trim().toLowerCase();
  const method = request.method.trim().toUpperCase();
  const path = request.path || '/';
  for (const rule of policy.rules) {
    if (!hostMatches(rule.host, host)) continue;
    if (rule.methods && rule.methods.length > 0 && !rule.methods.includes(method)) continue;
    if (!pathMatches(rule.path, path)) continue;
    return rule;
  }
  return null;
}

// ── Handles ─────────────────────────────────────────────────────────────────

/** The default prefix. Self-describing on purpose: when a stray SDK sends this
 *  somewhere it should not, the upstream's 401 puts a remediation hint straight
 *  into the model's own context instead of an opaque failure. */
export const DEFAULT_HANDLE_PREFIX = 'kortix_brokered__use_kortix_fetch__';

const HANDLE_MARKER = 'KXS1';
const LOOKUP_LEN = 20;
const TAG_LEN = 16;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Buffer, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += BASE32[bytes[i % bytes.length] % 32];
  return out;
}

function handleKey(rootSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', rootSecret, 'kortix-secret-handle', 'kxs-v1', 32) as ArrayBuffer,
  );
}

function tagFor(rootSecret: string, lookupId: string): string {
  const mac = createHmac('sha256', handleKey(rootSecret)).update(`kxs.v1|${lookupId}`).digest();
  return base32(mac, TAG_LEN);
}

/**
 * Build the opaque value the sandbox receives in place of a real secret.
 *
 * The whole string stays within `[A-Za-z0-9_-]` so it survives shell quoting in
 * `agent-env.sh`, JSON bodies, headers and query strings unchanged — a handle
 * that gets mangled in transit reads to the user as "the platform is broken".
 *
 * `prefix` may be shaped like the vendor's real key (`sk-ant-api03-`) for SDKs
 * that validate key format before sending.
 */
export function mintHandle(input: {
  lookupId: string;
  prefix?: string | null;
  rootSecret: string;
}): string {
  const prefix = input.prefix?.trim() || DEFAULT_HANDLE_PREFIX;
  return `${prefix}${HANDLE_MARKER}${input.lookupId}${tagFor(input.rootSecret, input.lookupId)}`;
}

/** A random lookup id of the fixed width `mintHandle` expects. */
export function newLookupId(random: Buffer): string {
  return base32(random, LOOKUP_LEN);
}

export type HandleParse =
  | { ok: true; lookupId: string; prefix: string }
  | { ok: false; reason: 'not_a_handle' | 'bad_tag' };

/**
 * Recover the lookup id from a handle, verifying its tag FIRST.
 *
 * The tag is checked statelessly, before any database work, for two reasons: an
 * agent spraying guessed handles cannot turn the broker into a query amplifier,
 * and a bad tag (FORGED) stays distinguishable from a good tag on the wrong
 * session (STOLEN) — which are very different alerts.
 */
export function parseHandle(value: string, rootSecret: string): HandleParse {
  const marker = value.lastIndexOf(HANDLE_MARKER);
  if (marker < 0) return { ok: false, reason: 'not_a_handle' };
  const body = value.slice(marker + HANDLE_MARKER.length);
  if (body.length !== LOOKUP_LEN + TAG_LEN) return { ok: false, reason: 'not_a_handle' };

  const lookupId = body.slice(0, LOOKUP_LEN);
  const tag = body.slice(LOOKUP_LEN);
  const expected = tagFor(rootSecret, lookupId);
  const a = Buffer.from(tag);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_tag' };
  return { ok: true, lookupId, prefix: value.slice(0, marker) };
}

/** Cheap pre-filter: does this look like a dosco handle at all? Used to decide
 *  whether a value is worth parsing, never as an authorization check. */
export function looksLikeHandle(value: string): boolean {
  return value.includes(HANDLE_MARKER);
}

// ── The delivery decision ───────────────────────────────────────────────────

/**
 * Why nothing at all was emitted for a row.
 *
 * These stay distinct because each is a different thing for a human to fix, and
 * "my secret isn't in the box" is otherwise indistinguishable from a platform
 * bug. They are diagnostic labels, not a hierarchy — a row can qualify for
 * several and only the first one checked is reported.
 */
export type SecretWithheldReason =
  | 'denied'
  | 'agent_grant_excludes'
  | 'agent_grant_unscoped'
  | 'session_allowlist_excludes'
  | 'no_session';

/**
 * What a single secret row contributes to the sandbox.
 *
 * A discriminated union rather than a nullable value because the three outcomes
 * have genuinely different consequences downstream: `plaintext` puts a live
 * credential in `env`, `handle` puts a mintable placeholder there (so the caller
 * must go and mint one), and `nothing` must also suppress the NAME. Collapsing
 * the last two into "no value" is exactly the mistake that desynchronises
 * `KORTIX_PROJECT_SECRET_NAMES` from the env map.
 */
export type SecretDelivery =
  | { emit: 'plaintext'; strategy: 'runtime' }
  | { emit: 'handle'; strategy: 'egress' | 'broker' }
  | { emit: 'nothing'; strategy: SecretStrategy; reason: SecretWithheldReason };

export interface SecretDeliveryInput {
  /** The secret's identifier — the unit the agent grant and the session
   *  allowlist both address. NOT the env KEY: `name` is deliberately
   *  non-unique per project. */
  identifier: string;
  /** `project_secrets.strategy`. Absent means the row expresses no opinion. */
  strategy?: SecretStrategy | null;
  /** `projects.secret_default_strategy`. */
  projectDefaultStrategy?: SecretStrategy | null;
  /** A strategy declared for this secret in the repo manifest's `[env]`. A bare
   *  string entry (today's only form) declares NOTHING and must be passed as
   *  null, not `'runtime'`. */
  manifestStrategy?: SecretStrategy | null;
  /**
   * The running agent's `secrets` grant, and the per-session allowlist, passed
   * SEPARATELY and UN-INTERSECTED.
   *
   * `intersectSecretGrants` (../projects/secrets.ts) folds an absent agent grant
   * into whatever the session named, which is correct for `runtime` but erases
   * the one fact this function needs: whether anybody actually declared that
   * this agent may hold this secret. Pass the raw axes.
   */
  agentGrantEnv?: string[] | 'all' | null;
  sessionAllowlist?: string[] | null;
  /** The session a handle would be minted against. Absent on any path that
   *  resolves secrets without a live session. */
  sessionId?: string | null;
}

/** Grant/allowlist membership. Case-insensitive, matching `agentMayUseEnv` and
 *  `intersectSecretGrants` — a hand-written `secrets:` list in kortix.yaml may
 *  use any case. */
function listAdmits(list: string[], identifier: string): boolean {
  const target = identifier.toUpperCase();
  return list.some((entry) => entry.toUpperCase() === target);
}

/**
 * The delivery decision for ONE secret row. Pure.
 *
 * Two rules here are stricter than the paths they sit beside, and both are
 * deliberate:
 *
 * 1. **An unscoped agent grant DENIES a non-`runtime` row.** `agentMayUseEnv`
 *    (../iam/agent-scope.ts) returns true for a null grant — "no grant = no
 *    restriction" — and `secret-grant.ts` documents that `undefined` and `'all'`
 *    are the same authority everywhere it is applied, since `'all'` is what an
 *    agent that merely OMITS `secrets:` produces. That fail-open is load-bearing
 *    back-compat for `runtime` and nothing legacy depends on it for the new
 *    classes, so it is closed exactly where it costs nothing: an ungoverned
 *    project cannot acquire a brokered credential by accident. Only an explicit
 *    identifier list carries a non-`runtime` secret.
 *
 * 2. **No session id ⇒ every non-`runtime` row emits nothing.** A handle is
 *    minted per (session, secret); with no session there is nothing to mint and
 *    nothing to revoke. The only alternatives are to fall back to plaintext —
 *    which defeats the entire feature on whichever code path forgot to thread a
 *    session id — or to emit a name with no value, which desynchronises the box.
 *
 * `denied` is checked first so its reason survives: it is a policy statement
 * about the secret, and it stays true no matter who is asking.
 */
export function resolveSecretDelivery(input: SecretDeliveryInput): SecretDelivery {
  const strategy = maxStrategy(
    input.strategy,
    input.projectDefaultStrategy,
    input.manifestStrategy,
  );
  const withheld = (reason: SecretWithheldReason): SecretDelivery => ({
    emit: 'nothing',
    strategy,
    reason,
  });

  if (strategy === 'denied') return withheld('denied');

  const grant = input.agentGrantEnv ?? null;
  if (Array.isArray(grant)) {
    if (!listAdmits(grant, input.identifier)) return withheld('agent_grant_excludes');
  } else if (strategy !== 'runtime') {
    return withheld('agent_grant_unscoped');
  }

  // Absent allowlist = the session declined to narrow (byte-identical to the
  // pre-KaaB path). An EMPTY one is a declaration that this session gets no
  // project secrets at all, and must not be confused with absence.
  const allowlist = input.sessionAllowlist ?? null;
  if (allowlist !== null && !listAdmits(allowlist, input.identifier)) {
    return withheld('session_allowlist_excludes');
  }

  if (strategy === 'runtime') return { emit: 'plaintext', strategy };
  if (!input.sessionId) return withheld('no_session');
  return { emit: 'handle', strategy };
}

/** True when this row puts SOMETHING under its env KEY — a real value or a
 *  handle. The single predicate both the env map and the name list are built
 *  from, so the two cannot disagree. */
export function emitsValue(delivery: SecretDelivery): boolean {
  return delivery.emit !== 'nothing';
}

export interface DeliveredSecret {
  /** The env var KEY (`project_secrets.name`). Several identifiers may share
   *  one — that is a supported project shape, not a conflict. */
  key: string;
  delivery: SecretDelivery;
}

/**
 * Exactly what belongs in `KORTIX_PROJECT_SECRET_NAMES`.
 *
 * The invariant, which is not cosmetic: **a name appears here IFF a value (real
 * or handle) is emitted for it.** The daemon's env store seeds `knownNames` from
 * this list (project-env.ts) and scrubs/serves by it, so a name with no value
 * makes the box advertise a variable it does not have, and a value with no name
 * leaves a live credential outside the store's management — unscrubbable and
 * un-updatable by a later hot push.
 *
 * A KEY served by several identifiers appears once as soon as ANY of them
 * emits: the env map holds one value under that key (`resolveGrantedSecretEnv`
 * picks the winner), so the name is either present or it is not. A key whose
 * every identifier is withheld disappears entirely.
 *
 * Reserved-name filtering is NOT done here — `sanitizeSandboxEnv`
 * (../projects/lib/sandbox-env-names.ts) owns that, and the list must be
 * computed AFTER it runs, not beside it.
 */
export function secretNamesForSandbox(rows: DeliveredSecret[]): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    if (emitsValue(row.delivery)) names.add(row.key);
  }
  return [...names].sort();
}
