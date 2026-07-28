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
 * - `egress`  — a format-shaped handle goes in the box; a Kortix proxy OUTSIDE
 *   the guest swaps it for the real value on a matching outbound request.
 * - `broker`  — the value never leaves the server; the agent reaches the
 *   upstream through a named Kortix chokepoint.
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
export function maxStrategy(
  ...declared: Array<SecretStrategy | null | undefined>
): SecretStrategy {
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

export type EgressInjection =
  | { kind: 'header'; name: string; prefix?: string }
  | { kind: 'query'; name: string }
  | { kind: 'body_field'; path: string };

export interface EgressRule {
  /** Exact host, or ONE leading `*.` wildcard label. Never a regex. */
  host: string;
  /** Uppercased HTTP methods; empty/absent means any. */
  methods?: string[];
  /** Exact path, or one trailing `/*`. Absent means any path. */
  path?: string;
}

export interface SecretEgressPolicy {
  rules: EgressRule[];
  inject: EgressInjection;
  /** For `broker`: which Kortix chokepoint serves this secret. */
  backend?: 'llm_gateway' | 'executor' | 'git_proxy' | 'kortix_fetch';
  /** Env var to point an SDK at the broker, e.g. `ANTHROPIC_BASE_URL`. */
  base_url_env?: string;
}

export type EgressPolicyParse =
  | { ok: true; policy: SecretEgressPolicy }
  | { ok: false; error: string };

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

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

export function parseEgressPolicy(input: unknown): EgressPolicyParse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'policy must be an object' };
  }
  const raw = input as Record<string, unknown>;

  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    return { ok: false, error: 'policy.rules must be a non-empty array' };
  }
  const rules: EgressRule[] = [];
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

    rules.push({ host, ...(methods ? { methods } : {}), ...(path ? { path } : {}) });
  }

  const injectRaw = raw.inject;
  if (!injectRaw || typeof injectRaw !== 'object') {
    return { ok: false, error: 'policy.inject is required' };
  }
  const inj = injectRaw as Record<string, unknown>;
  let inject: EgressInjection;
  if (inj.kind === 'header') {
    if (typeof inj.name !== 'string' || !inj.name.trim()) {
      return { ok: false, error: 'inject.name is required for a header injection' };
    }
    inject = {
      kind: 'header',
      name: inj.name.trim(),
      ...(typeof inj.prefix === 'string' ? { prefix: inj.prefix } : {}),
    };
  } else if (inj.kind === 'query') {
    if (typeof inj.name !== 'string' || !inj.name.trim()) {
      return { ok: false, error: 'inject.name is required for a query injection' };
    }
    inject = { kind: 'query', name: inj.name.trim() };
  } else if (inj.kind === 'body_field') {
    if (typeof inj.path !== 'string' || !inj.path.trim()) {
      return { ok: false, error: 'inject.path is required for a body_field injection' };
    }
    inject = { kind: 'body_field', path: inj.path.trim() };
  } else {
    return { ok: false, error: `unknown inject.kind: ${String(inj.kind)}` };
  }

  const backend = raw.backend;
  if (
    backend !== undefined &&
    !['llm_gateway', 'executor', 'git_proxy', 'kortix_fetch'].includes(String(backend))
  ) {
    return { ok: false, error: `unknown backend: ${String(backend)}` };
  }

  return {
    ok: true,
    policy: {
      rules,
      inject,
      ...(backend ? { backend: backend as SecretEgressPolicy['backend'] } : {}),
      ...(typeof raw.base_url_env === 'string' ? { base_url_env: raw.base_url_env } : {}),
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
): EgressRule | null {
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
  const mac = createHmac('sha256', handleKey(rootSecret))
    .update(`kxs.v1|${lookupId}`)
    .digest();
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

/** Cheap pre-filter: does this look like a Kortix handle at all? Used to decide
 *  whether a value is worth parsing, never as an authorization check. */
export function looksLikeHandle(value: string): boolean {
  return value.includes(HANDLE_MARKER);
}
