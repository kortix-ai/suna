// Delivering a freshly re-scoped secret snapshot to a box that is already
// running.
//
// The PUT /scope route persists the new `secretsAllowlist` and used to rely
// ENTIRELY on the per-prompt hot sync (`syncSandboxEnvForPrompt`) to push it to
// the live sandbox. That sync is path-gated — it only fires on
// `POST /session/:id/(prompt_async|message)` to the daemon port — so a prompt
// that takes the direct-opencode path, a session not prompted again right
// away, or any path that skips the gate left the sandbox running the OLD
// snapshot: the daemon's agent-env.sh kept the stale `names`, opencode kept its
// PID, and every shell the agent spawned still saw the pre-scope secret set,
// while the API answered "Applies from the next prompt."
//
// `pushSessionScopeToSandbox` is the immediate push the route now makes after the
// DB write — same shape as `pushSessionModelToSandbox`, but it pushes the
// resolved secret snapshot (no model override) and asks the daemon to
// `refreshModels` so opencode restarts and shells spawned after the rescope
// inherit the new secret set instead of the old agent-env.sh via BASH_ENV.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';

process.env.KORTIX_URL = 'https://api.example.com';

let snapshot: { env: Record<string, string>; names: string[]; revision: string } | null = {
  env: { MAIL_TOKEN: 'redacted-do-not-assert-values', ISSUE_TOKEN: 'redacted' },
  names: ['MAIL_TOKEN', 'ISSUE_TOKEN'],
  revision: 'rev-after-rescope',
};
let posted: Array<{
  snapshot: { env: unknown; names: unknown; revision: unknown } | undefined;
  opencodeEnv: Record<string, string | null> | undefined;
  refreshModels: boolean | undefined;
}> = [];
// One fake row that satisfies every select on this path — the sandbox lookup
// and the session/project lookups `resolveSandboxEnvSnapshot` walks on its way
// to an env snapshot. Cheaper than teaching the fake db which table it was
// asked for.
const SANDBOX_ROW = { externalId: 'ext-1', config: { serviceKey: 'svc-key' } };
const SESSION_ROW_BASE = {
  createdBy: 'user-1' as string | null,
  agentName: 'support',
  secretsAllowlist: null,
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  accountId: 'acct-1',
};
// Per-test override of the session row (e.g. `createdBy: null` to exercise the
// no-env-snapshot path). `null` means no row matches at all.
let sessionRow: typeof SESSION_ROW_BASE | null = SESSION_ROW_BASE;
let activeSandbox: { externalId: string; config: Record<string, unknown> } | null = SANDBOX_ROW;

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            // The sandbox lookup needs the sandbox's externalId + config; the
            // session/project lookups `resolveOwnerRawEnv` walks need the
            // session row. A single fused row carries both, but the
            // no-sandbox and no-session cases must be independently nullable.
            if (!activeSandbox) return [];
            return sessionRow ? [{ ...sessionRow, ...activeSandbox }] : [];
          },
        }),
      }),
    }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionSecretGrant: async () => 'all' as const,
}));
// Spread the real module: overriding only the DB-backed reader keeps every other
// export (sanitizers, revision hashing) intact — a partial mock silently removes
// the rest and the module fails to load.
mock.module('../secrets', () => ({
  ...realSecrets,
  // `{ env, names, revision }` — the real return shape. An array here made
  // `.env` undefined, which produced the "no env snapshot" the test below
  // asserts. It would have passed for the wrong reason.
  listProjectSecretsSnapshotForUser: async () => {
    if (!snapshot) return { env: {}, names: [], revision: '' };
    return snapshot;
  },
}));

mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
let fetchShouldFail = false;
(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
  if (fetchShouldFail) throw new Error('daemon unreachable');
  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  posted.push({
    snapshot: {
      env: body.env,
      names: body.names,
      revision: body.revision,
    },
    opencodeEnv: body.opencodeEnv as Record<string, string | null> | undefined,
    refreshModels: body.refreshModels as boolean | undefined,
  });
  return Response.json({ ok: true, opencode: 'starting' });
};

const { pushSessionScopeToSandbox } = await import('./sandbox-env-sync');

const INPUT = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
};

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  snapshot = {
    env: { MAIL_TOKEN: 'redacted-do-not-assert-values', ISSUE_TOKEN: 'redacted' },
    names: ['MAIL_TOKEN', 'ISSUE_TOKEN'],
    revision: 'rev-after-rescope',
  };
  posted = [];
  sessionRow = SESSION_ROW_BASE;
  activeSandbox = SANDBOX_ROW;
  fetchShouldFail = false;
});

describe('pushSessionScopeToSandbox', () => {
  test('pushes the re-scoped snapshot and asks for the opencode restart', async () => {
    // opencode reads agent-env.sh via BASH_ENV on every shell spawn, but the
    // file is only re-rendered when the daemon's env store changes; and the
    // opencode PROCESS keeps its old env until it restarts. `refreshModels` is
    // what makes the daemon rewrite the live agent-env file AND restart
    // opencode, so shells spawned AFTER the rescope see the new secret set
    // instead of the old one.
    const result = await pushSessionScopeToSandbox(INPUT);

    expect(result).toEqual({ applied: true });
    expect(posted).toHaveLength(1);
    expect(posted[0].refreshModels).toBe(true);
    // The pushed snapshot carries the resolved env (the new allowlist ∩ the
    // agent grant). `resolveSandboxEnvSnapshot` re-hashes the env into the
    // revision (projectSecretsRevision), so the posted revision is a real hash
    // of the env, not the fake `revision` field — the daemon's revision-guarded
    // `apply` makes a duplicate push (here then on the next prompt) a no-op,
    // so there is no race.
    expect(typeof posted[0].snapshot?.revision).toBe('string');
    expect(posted[0].snapshot?.revision).not.toBe('');
    // `sanitizeSandboxEnv` sorts names alphabetically (uppercase), so the
    // pushed names arrive in canonical order regardless of the snapshot's
    // insertion order.
    expect(posted[0].snapshot?.names).toEqual(['ISSUE_TOKEN', 'MAIL_TOKEN']);
    // A scope push sends NO opencodeEnv override (unlike the model push, which
    // sets KORTIX_OPENCODE_MODEL). It only re-delivers the secret snapshot.
    expect(posted[0].opencodeEnv).toBeUndefined();
  });

  test('does not expose secret values through its return value', async () => {
    // Regression guard for the "do not expose values" constraint: the snapshot
    // IS the values (they have to reach the daemon over the server-to-server
    // /kortix/env endpoint), but the helper's RETURN value — and the route's
    // response — never carry them. The helper returns a bare
    // { applied } / { applied, reason }; the route returns the SessionScope
    // shape (allowlist NAMES, not values). Pin that no env value leaks out.
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result).toEqual({ applied: true });
    expect(JSON.stringify(result)).not.toContain('redacted');
    expect(JSON.stringify(result)).not.toContain('MAIL_TOKEN');
    expect(JSON.stringify(result)).not.toContain('ISSUE_TOKEN');
  });

  test('no active sandbox is a no-op, not an error', async () => {
    // A session with no live box picks the new scope up on its next boot —
    // failing the PUT over that would roll back a perfectly good DB write.
    activeSandbox = null;
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result.applied).toBe(false);
    expect(posted).toEqual([]);
  });

  test('a sandbox with no service key is refused rather than pushed unauthenticated', async () => {
    activeSandbox = { externalId: 'ext-1', config: {} };
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result.applied).toBe(false);
    expect(posted).toEqual([]);
  });

  test('a session with no env snapshot pushes nothing', async () => {
    // `resolveSandboxEnvSnapshot` returns null when `resolveOwnerRawEnv`
    // returns null — which happens when the session row has no `createdBy`
    // (the owner-principal the snapshot is resolved for). Pushing an empty
    // snapshot would DELETE the box's live secret env, so the helper refuses.
    sessionRow = { ...SESSION_ROW_BASE, createdBy: null };
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result.applied).toBe(false);
    expect(posted).toEqual([]);
  });

  test('a daemon failure is caught and reported, never thrown at the caller', async () => {
    // Best-effort by design: the DB write already landed, so a transient
    // daemon miss must not 500 the PUT. The per-prompt sync (or the next
    // boot) still converges the box.
    fetchShouldFail = true;
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('daemon unreachable');
  });
});

/**
 * The route has to actually call the push after the DB write.
 *
 * The helper can be perfectly correct and the sandbox still run the OLD
 * snapshot — the route is the one that decides to push, and it used to
 * deliberately NOT push (the "No push needed" comment relied on the
 * per-prompt sync, which is path-gated and not guaranteed to fire). Same shape
 * of bug as a correct helper wired to nothing: right logic, wrong plumbing.
 * Pin the wiring so a future refactor can't silently drop it.
 */
const ROUTE = readFileSync(join(import.meta.dir, '..', 'routes', 'r7.ts'), 'utf8');

describe('the scope route pushes the new snapshot to the live sandbox', () => {
  test('imports and calls pushSessionScopeToSandbox after the DB transaction', () => {
    expect(ROUTE).toContain('pushSessionScopeToSandbox');
    // The push must come AFTER the DB transaction commits, not before —
    // pushing a scope that failed to persist would hand the box a state the
    // route then rolls back. The transaction block ends just above this call.
    expect(ROUTE).toMatch(/await pushSessionScopeToSandbox\(\{ projectId, sessionId \}\)/);
  });

  test('only pushes when the secrets axis actually changed', () => {
    // A no-op PUT (re-sending the same allowlist) must NOT restart opencode —
    // that costs the user their in-flight turn for nothing. The gate is
    // `wantsSecrets` AND a real delta between the new and previous allowlist.
    expect(ROUTE).toContain('wantsSecrets');
    expect(ROUTE).toMatch(
      /JSON\.stringify\(nextAllowlist\) !== JSON\.stringify\(visible\.row\.secretsAllowlist \?\? null\)/,
    );
  });

  test('no longer claims the per-prompt sync alone is enough', () => {
    // The old comment — "No push needed: the per-prompt hot sync re-reads
    // secretsAllowlist ... on the NEXT prompt" — was the buggy assumption this
    // fix replaces. It must not come back.
    expect(ROUTE).not.toContain('No push needed');
  });
});
