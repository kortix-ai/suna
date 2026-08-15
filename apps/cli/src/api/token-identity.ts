import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { configFilePath } from './config.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Who is this token?
//
// A sandbox CLI authenticates with a MINTED AGENT TOKEN — project- and
// session-scoped, carrying that agent's `kortix_cli` grant from kortix.yaml.
// Nothing in the sandbox names the agent: `agent-env.sh` ships the token, the
// API URL, and the project/session ids, never the agent it was minted for
// (apps/kortix-sandbox-agent-server/src/agent-env-file.ts). So a 403 like
// "You don't have permission (project.session.read)" gave the agent no way to
// see WHICH identity was refused, and the standing host line could not say it
// either.
//
// The only authority is `GET /v1/accounts/me` → `token_context`. This module
// caches that answer so the host line stays a zero-network render (same
// contract as update-check.ts) and so a denial can name the identity without a
// second round trip.
//
// The cache stores NO token — entries are keyed by a SHA-256 prefix of it, so
// a re-minted token misses the cache instead of showing a stale agent. That
// matters: the platform re-resolves the grant on every prompt, and an agent
// switch mid-session changes the answer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `/accounts/me` fields this module reads.
 *
 * Declared structurally instead of importing `MeResponse` on purpose. This
 * file is reachable from `api/client.ts`, which puts it in the in-sandbox
 * `kortix connectors` import closure — every file in that closure is hashed
 * into the snapshot runtime fingerprint (see cli-connector-closure.test.ts).
 * `api/types.ts` changes with every API type addition (23 commits in 6
 * months), so pulling it into the fingerprint would re-mint every project's
 * runtime identity on edits that cannot affect the connector binary.
 * `MeResponse` satisfies this shape, so callers pass it unchanged.
 */
export interface AccountsMeBody {
  user_id: string;
  email?: string;
  token_context?: {
    auth_type?: string | null;
    project_id?: string | null;
    session_id?: string | null;
    agent?: string | null;
    kortix_cli?: string[] | 'all' | null;
  };
}

/** What a minted token resolves to. Mirrors `MeResponse.token_context`. */
export interface TokenIdentity {
  /** 'pat' | 'supabase' | … — the API's own classification. */
  authType: string | null;
  /** Agent the session token was minted for, or null for a user/project token. */
  agent: string | null;
  projectId: string | null;
  sessionId: string | null;
  /** The agent's `kortix_cli` grant: 'all', an explicit list, or null (ungated). */
  kortixCli: string[] | 'all' | null;
  userId: string;
  userEmail: string;
}

interface CacheEntry {
  identity: TokenIdentity;
  fetchedAt: number;
}

interface CacheFile {
  entries: Record<string, CacheEntry>;
}

/** A grant can change under a running session (a CR-merged kortix.yaml, an
 *  agent switch that re-mints). Short enough that a fixed grant is re-read
 *  within a working session; long enough that the header never costs a call. */
const TTL_MS = 15 * 60 * 1000;

/** Bound the file. Entries are ~200 bytes; the cap only matters on a dev box
 *  that cycles through many tokens. */
const MAX_ENTRIES = 8;

/** Same directory as the config + update-check cache (~/.config/kortix), so a
 *  test that redirects KORTIX_CONFIG_FILE redirects this too. */
function cachePath(): string {
  return resolve(dirname(configFilePath()), 'token-identity.json');
}

/** Key a cache entry WITHOUT storing the credential. */
function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Within one process the disk cache is read once — a command that renders the
 *  header and then 403s must not re-read the file for the same answer. */
const memo = new Map<string, CacheEntry>();

function readCacheFile(): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<CacheFile>;
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { entries: parsed.entries };
    }
  } catch {
    /* absent or corrupt — an empty cache is always a valid answer */
  }
  return { entries: {} };
}

function writeCacheFile(file: CacheFile): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    // Newest first, then truncate — an eviction must never drop the entry we
    // just wrote.
    const kept = Object.entries(file.entries)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, MAX_ENTRIES);
    writeFileSync(path, JSON.stringify({ entries: Object.fromEntries(kept) }, null, 2) + '\n', {
      mode: 0o600,
    });
    try {
      // `mode` only applies on create; a pre-existing file keeps its old mode.
      chmodSync(path, 0o600);
    } catch {
      /* Windows */
    }
  } catch {
    /* a read-only HOME must not break the command that triggered the write */
  }
}

/** Translate an `/accounts/me` body into the cached shape. */
export function identityFromMe(me: AccountsMeBody): TokenIdentity {
  const ctx = me.token_context;
  return {
    authType: ctx?.auth_type ?? null,
    agent: ctx?.agent ?? null,
    projectId: ctx?.project_id ?? null,
    sessionId: ctx?.session_id ?? null,
    kortixCli: ctx?.kortix_cli ?? null,
    userId: me.user_id,
    userEmail: me.email ?? '',
  };
}

/**
 * Record what a token resolves to. Called from the API client for EVERY
 * `/accounts/me` response, so the many commands that already fetch it
 * (whoami, projects, accounts, login, doctor, ship, the session scan) warm the
 * cache without a single extra request.
 */
export function rememberTokenIdentity(token: string, me: AccountsMeBody): void {
  if (!token) return;
  const key = tokenKey(token);
  const entry: CacheEntry = { identity: identityFromMe(me), fetchedAt: Date.now() };
  memo.set(key, entry);
  const file = readCacheFile();
  file.entries[key] = entry;
  writeCacheFile(file);
}

/**
 * The token's identity if we already know it — never touches the network.
 * `allowStale` returns an expired entry, for the error path where a slightly
 * old agent name still beats printing nothing.
 */
export function cachedTokenIdentity(
  token: string,
  opts: { allowStale?: boolean } = {},
): TokenIdentity | null {
  if (!token) return null;
  const key = tokenKey(token);
  const entry = memo.get(key) ?? readCacheFile().entries[key];
  if (!entry || typeof entry.fetchedAt !== 'number' || !entry.identity) return null;
  memo.set(key, entry);
  if (!opts.allowStale && Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.identity;
}

/** Drop every cached entry. Test seam. */
export function clearTokenIdentityCache(): void {
  memo.clear();
}

/** Render a grant list for display. */
export function formatGrantList(value: string[] | 'all' | null): string {
  if (value === 'all') return 'all';
  if (value == null) return 'ungated';
  return value.length ? value.join(', ') : 'none';
}

/** One-line label for the token itself: what kind it is, and whose it is. */
export function tokenKindLabel(identity: TokenIdentity): string {
  const kind = identity.sessionId
    ? 'session token'
    : identity.projectId
      ? 'project token'
      : identity.authType || 'token';
  return identity.agent ? `${kind} · agent ${identity.agent}` : kind;
}
