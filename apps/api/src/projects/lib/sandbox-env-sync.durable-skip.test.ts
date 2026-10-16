// End-to-end (module-level) proof of the fix for the 2026-09-27 dev
// benchmark: a 2-replica API meant `syncSandboxEnvForPrompt`'s in-process
// memo (`lastPromptModelSignature`) missed on roughly
// half of every session's turns, so a session's second and later prompts
// re-pushed `/kortix/env` and re-triggered a full OpenCode respawn almost
// every turn instead of only the first.
//
// This suite proves the DURABLE half of the fix actually closes that gap: a
// simulated "different replica" (an in-process cache reset, via
// `__resetPromptModelSignatureCacheForTests`) still skips the daemon
// round-trip, because it reads the SAME signature another "replica" already
// confirmed and persisted on `session_sandboxes.config`
// (`env-sync-durable-state.ts`). It also proves the staleness self-heal never
// blocks the turn that discovers it — the background refresh is observed
// only through the detached-promise test seam, never awaited inline with the
// prompt.
//
// Same `mock.module` + `globalThis.fetch` interception pattern as the sibling
// `sandbox-env-sync.refresh-models.test.ts` (isolated per file via
// `bun test --isolate`).
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { applyEnvSyncDurableWrite } from '../../__tests__/helpers/env-sync-durable-fake';

import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';

const PROJECT_ROW = {
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  metadata: null as Record<string, unknown> | null,
};

let llmGatewayEnabled = false;
mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => llmGatewayEnabled,
}));

const SESSION_ROW = {
  createdBy: 'user-1',
  agentName: 'support',
  secretsAllowlist: null as string[] | null,
};

let snapshotEnv: Record<string, string> = { EXAMPLE: 'v1' };
let snapshotNames: string[] = ['EXAMPLE'];
let snapshotRevision = 'rev-1';
let snapshotCapabilitiesJson = '{"version":1,"capabilities":[]}';

/** The one fake row of durable state — this suite only ever exercises one
 *  session/sandbox, so a single mutable slot is enough. */
let durableConfig: Record<string, unknown> | null = null;
/** Who the session token acts for (`account_tokens.on_behalf_of_user_id`). */
let tokenPerson: string | null = 'creator';
let sandboxConfigReads = 0;

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if ('onBehalfOf' in columns) {
            // The session token's person (sandbox-env-push.ts `sessionTokenPerson`).
            const rows = [{ onBehalfOf: tokenPerson }];
            return { limit: async () => rows };
          }
          const wantsSession = 'createdBy' in columns;
          const wantsSandboxConfig = !wantsSession && Object.keys(columns).length === 1 && 'config' in columns;
          if (wantsSandboxConfig) sandboxConfigReads += 1;
          const rows = wantsSession
            ? [SESSION_ROW]
            : wantsSandboxConfig
              ? [{ config: durableConfig }]
              : [PROJECT_ROW];
          return {
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: () => ({
      set: (patch: { config?: unknown }) => ({
        where: async () => {
          durableConfig = applyEnvSyncDurableWrite(durableConfig, patch.config);
        },
      }),
    }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionSecretGrant: async () => 'all' as const,
}));

mock.module('../secrets', () => ({
  ...realSecrets,
  listProjectSecretsSnapshotForUser: async () => ({
    env: snapshotEnv,
    names: snapshotNames,
    revision: snapshotRevision,
    capabilitiesJson: snapshotCapabilitiesJson,
  }),
}));

mock.module('./network-secret-boundary', () => ({
  resolveSessionNetworkBoundary: async () => [],
}));

type PostedBody = { revision: unknown; refreshModels: unknown };
let posted: PostedBody[] = [];

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ? (JSON.parse(init.body) as PostedBody) : ({} as PostedBody);
  posted.push(body);
  return Response.json({
    ok: true,
    revision: body.revision,
    exported: 1,
    managed: 1,
    withheld: 0,
    agent_env_written: true,
    opencode: 'ok',
  });
};

const { recordDaemonBootForEnvSync } = await import('./env-sync-durable-state');
const {
  syncSandboxEnvForPrompt,
  __resetPromptModelSignatureCacheForTests,
  __resetBackgroundEnvRefreshForTests,
  __pendingBackgroundEnvRefreshesForTests,
  __pendingEnvChecksForTests,
  ENV_SYNC_BACKGROUND_REFRESH_STALE_MS,
  PROMPT_MODEL_SIGNATURE_CACHE_MAX,
} = await import('./sandbox-env-sync');

function prompt(externalId = 'ext-1') {
  return syncSandboxEnvForPrompt({
    projectId: 'proj-1',
    sessionId: 'sess-1',
    externalId,
    serviceKey: 'svc-key',
    previewUrl: 'https://sandbox.test',
    providerHeaders: {},
    providerName: 'daytona',
  });
}

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  __resetPromptModelSignatureCacheForTests();
  __resetBackgroundEnvRefreshForTests();
  posted = [];
  durableConfig = null;
  tokenPerson = 'creator';
  sandboxConfigReads = 0;
  snapshotEnv = { EXAMPLE: 'v1' };
  snapshotNames = ['EXAMPLE'];
  snapshotRevision = 'rev-1';
  snapshotCapabilitiesJson = '{"version":1,"capabilities":[]}';
  PROJECT_ROW.metadata = null;
  llmGatewayEnabled = false;
});

afterEach(async () => {
  // Drain anything a test scheduled in the background so it can never leak
  // fetch calls or unhandled rejections into the next test.
  await Promise.all(__pendingBackgroundEnvRefreshesForTests());
  await Promise.all(__pendingEnvChecksForTests());
});

// A turn whose bind changed the session's person: the box may still hold the
// previous person's personal secrets (a private session's creator, before an
// admin or a Slack participant prompts it). The trusted fast path would forward
// the prompt first and drop those secrets only one turn later.
describe('syncSandboxEnvForPrompt — a change of person is never trusted', () => {
  test('the same agent, same person, inside the window: the prompt is forwarded on the trusted memo', async () => {
    await prompt();
    expect(posted).toHaveLength(1);
    snapshotEnv = {}; // the previous person's personal secret is no longer theirs to read
    snapshotNames = [];
    snapshotRevision = 'rev-2';

    await prompt();
    expect(posted).toHaveLength(1); // forwarded before any push
  });

  test('the token now acts for another person: the env is resolved and pushed before the prompt is forwarded', async () => {
    await prompt();
    expect(posted).toHaveLength(1);
    tokenPerson = null; // another member prompted the creator's private session
    snapshotEnv = {};
    snapshotNames = [];
    snapshotRevision = 'rev-2';

    await prompt();
    expect(posted).toHaveLength(2); // pushed before the prompt went on
    expect(posted[1]!.revision).not.toBe(posted[0]!.revision); // the env without the secret
  });
});

describe('syncSandboxEnvForPrompt — durable cross-replica skip', () => {
  test('a different "replica" (cold in-process memo) still skips once the durable record matches', async () => {
    // Turn 1, replica A: nothing durable yet — pushes, and persists.
    await prompt();
    expect(posted).toHaveLength(1);
    expect(durableConfig?.envSyncSignature).toBeDefined();

    // Turn 2 lands on a DIFFERENT replica: its in-process memo is cold. The
    // OLD (in-process-only) implementation would have re-pushed here — that
    // was exactly the dev-benchmark regression. It must instead read the
    // durable record another replica already wrote and skip.
    __resetPromptModelSignatureCacheForTests();
    await prompt();
    expect(posted).toHaveLength(1); // still just the one push
    expect(sandboxConfigReads).toBeGreaterThan(0); // it DID consult the durable store

    // Turn 3, back on the original replica (memory still warm from turn 1):
    // trusted, so it never waits for the env resolve. It pays exactly ONE
    // durable read: the memo is trusted only while the shared record still
    // says the box runs what the memo says (a daemon restart, or another
    // replica's push, changes the record and not this memo).
    const readsBeforeTurn3 = sandboxConfigReads;
    await prompt();
    expect(posted).toHaveLength(1);
    expect(__pendingEnvChecksForTests()).toHaveLength(1); // trusted: the resolve runs detached
    expect(sandboxConfigReads).toBe(readsBeforeTurn3 + 1);
  });

  test('a real secret change is still pushed synchronously even from a cold replica', async () => {
    await prompt();
    expect(posted).toHaveLength(1);

    // A genuine change lands, and the next prompt is served by a cold replica.
    snapshotEnv = { EXAMPLE: 'v2' };
    snapshotRevision = 'rev-2';
    __resetPromptModelSignatureCacheForTests();
    await prompt();

    expect(posted).toHaveLength(2);
    expect(posted[1]!.refreshModels).toBe(true);
  });

  test('the memo stays at its cap across more than a cap-worth of skip-path writes', async () => {
    // The bound probe. The memo is module-private, so the cap is observed
    // through its one visible consequence: eviction of the oldest entry. The
    // flood below writes MORE than `PROMPT_MODEL_SIGNATURE_CACHE_MAX` NEW
    // keys on the skip path — the path that historically hand-set the maps
    // with no eviction — and then re-prompts the sandbox whose entry was
    // written first.
    //
    // Bounded memo: the first entry was evicted, so its re-prompt misses
    // memory, resolves the env inline (no detached check) and consults the
    // durable record, still skipping. Unbounded memo (the old skip path): the
    // first entry survives every skip-path write, so the re-prompt is trusted
    // and its resolve runs detached — the pending-check assertion goes red.
    await prompt('ext-1');
    expect(posted).toHaveLength(1);

    for (let i = 2; i <= PROMPT_MODEL_SIGNATURE_CACHE_MAX + 1; i++) {
      await prompt(`ext-${i}`); // cold memo, durable match → a NEW skip-path key each time
    }
    expect(posted).toHaveLength(1); // the flood itself never pushed

    const readsBeforeOldest = sandboxConfigReads;
    await prompt('ext-1');
    expect(posted).toHaveLength(1); // still a skip — the decision never changed
    expect(__pendingEnvChecksForTests()).toHaveLength(0); // memory miss → resolved inline
    expect(sandboxConfigReads).toBe(readsBeforeOldest + 1); // → one durable consult
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(posted).toHaveLength(1); // and no background refresh either: the record is fresh

    // A recent entry survives the eviction and is still trusted.
    await prompt('ext-2001');
    expect(posted).toHaveLength(1);
    expect(__pendingEnvChecksForTests()).toHaveLength(1);
  });

  test('a stale-but-unchanged durable record skips synchronously and self-heals in the background', async () => {
    await prompt();
    expect(posted).toHaveLength(1);
    const signature = durableConfig?.envSyncSignature;

    // Simulate the confirmation aging past the self-heal threshold, as read by
    // a cold replica (never touches this process's own memo).
    durableConfig = {
      envSyncSignature: signature,
      envSyncAppliedAtMs: Date.now() - ENV_SYNC_BACKGROUND_REFRESH_STALE_MS - 5_000,
    };
    __resetPromptModelSignatureCacheForTests();

    // A mocked `fetch` that resolves instantly can't distinguish "never
    // awaited" from "awaited but fast" by wall-clock alone — both finish
    // within the same microtask flush. Prove the independence directly
    // instead: hold the NEXT `fetch` call open on a promise only this test
    // controls, then assert `prompt()` still resolves without it.
    let releaseBackgroundFetch: (() => void) | null = null;
    const backgroundFetchGate = new Promise<void>((resolve) => {
      releaseBackgroundFetch = resolve;
    });
    (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as PostedBody) : ({} as PostedBody);
      await backgroundFetchGate; // held open until this test releases it
      posted.push(body);
      return Response.json({
        ok: true,
        revision: body.revision,
        exported: 1,
        agent_env_written: true,
        opencode: 'ok',
      });
    };

    await prompt(); // must resolve WITHOUT the gate ever being released

    // The turn itself did not wait on the refresh — this is the "never let a
    // background refresh delay a turn" invariant. The background call was
    // fired (it's parked on the gate), but has not recorded anything yet.
    expect(posted).toHaveLength(1);

    // Now let the self-heal actually complete, and prove it did.
    releaseBackgroundFetch!();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(posted).toHaveLength(2);
    expect(posted[1]!.refreshModels).toBe(true);
  });
});

// 2026-10-16, local stack, real Platinum box. kortixd swapped its binary
// (`[runtime-assets] requesting agent swap; exiting for the supervisor`, exit
// 75) and the new process seeded its env store from the BOOT env. The API kept
// trusting the env it had pushed to the OLD process, so the next prompt inside
// ENV_SYNC_BACKGROUND_REFRESH_STALE_MS ran on the boot env: in a private
// session, the creator's personal secret for another person's turn
// (KRTX-2517). Every daemon process claims its initial turn once at boot, and
// that claim records the boot (`recordDaemonBootForEnvSync`).
describe('syncSandboxEnvForPrompt — a daemon restart drops the trust', () => {
  /** Turn 1 pushed 10 s ago; the daemon process booted 5 s ago. */
  async function pushThenRestartDaemon(): Promise<void> {
    await prompt();
    expect(posted).toHaveLength(1);
    durableConfig = { ...durableConfig, envSyncAppliedAtMs: Date.now() - 10_000 };
    await recordDaemonBootForEnvSync('sess-1', Date.now() - 5_000);
  }

  test('the next prompt pushes again on the replica that holds a fresh trusted memo', async () => {
    tokenPerson = 'admin'; // another member prompts the creator's private session
    await pushThenRestartDaemon();

    await prompt(); // same agent, same person, inside the trusted window
    expect(posted).toHaveLength(2); // pushed before the prompt went on
    expect(posted[1]!.revision).toBe(posted[0]!.revision); // the same env, now on the new process
    expect(__pendingEnvChecksForTests()).toHaveLength(0); // not trusted: resolved inline
  });

  test('the next prompt pushes again on a cold replica, which would otherwise skip on the durable record', async () => {
    await pushThenRestartDaemon();
    __resetPromptModelSignatureCacheForTests();

    await prompt();
    expect(posted).toHaveLength(2);
  });

  test('the push after the boot is trusted again', async () => {
    await pushThenRestartDaemon();
    await prompt();
    expect(posted).toHaveLength(2);

    await prompt();
    expect(posted).toHaveLength(2);
    expect(__pendingEnvChecksForTests()).toHaveLength(1);
  });

  test('a boot recorded before the last push leaves the trust in place', async () => {
    await recordDaemonBootForEnvSync('sess-1', Date.now() - 60_000);
    await prompt();
    expect(posted).toHaveLength(1);

    await prompt();
    expect(posted).toHaveLength(1);
  });
});

// The same hole without a restart. The memo is per replica; the box is one.
// Replica 1 pushed the env for the admin, replica 2 then pushed the creator's
// env (with their personal secret) for the creator's own prompt. Replica 1's
// memo still names the admin, the same agent, inside the window — and the box
// holds the creator's env.
describe('syncSandboxEnvForPrompt — another replica moved the box', () => {
  test("a memo that disagrees with the durable record is not trusted", async () => {
    tokenPerson = 'admin';
    await prompt();
    expect(posted).toHaveLength(1);
    durableConfig = {
      ...durableConfig,
      envSyncSignature: 'the-creator-env-pushed-by-another-replica',
      envSyncAppliedAtMs: Date.now(),
    };

    await prompt();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.revision).toBe(posted[0]!.revision); // the admin's env, back on the box
  });
});
