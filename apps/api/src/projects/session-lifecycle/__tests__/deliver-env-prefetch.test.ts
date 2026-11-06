/**
 * `deliverAfterWake` starts the first prompt's env reads when the woken box
 * goes active (`prefetchPromptEnv`). The proxy's pre-prompt sync takes that
 * prefetch only for the agent the prompt body names, so the delivery must key
 * it on the same agent: `turnAgent`, the `promptAgent` value continue-session
 * also writes into the body. On preview 2026-11-03 the prefetch keyed on the
 * request override alone: every default-agent session (no override, body
 * `agent: "mykortix"`) missed it — 9 of 18 sessions.
 *
 * `mock.module` is process-global; this file owns its module graph under
 * `bun test --isolate`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projects } from '@kortix/db';
import { signalSessionRuntimeActive } from '../runtime-active-signal';
import * as realEnvSync from '../../lib/sandbox-env-sync';
import * as realEnvPush from '../../lib/sandbox-env-push';
import * as realSessionOpen from '../../session-open';
import * as realHeal from '../../lib/heal-session-token';
import * as realActivity from '../../session-activity';

const SESSION_ID = 'sess-prefetch-1';
const PROJECT_ID = 'proj-1';

let prefetchCalls: Array<{ projectId: string; sessionId: string; agent: string | null | undefined }> = [];
let opens = 0;

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === projects
              ? [{ projectId: PROJECT_ID, accountId: 'acct-1' }]
              : [{ status: 'running', agentName: 'mykortix', accountId: 'acct-1', metadata: {} }],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

// First open: the box is still booting, and its daemon reports runtime-ready
// while the open is in flight. Second open: ready.
mock.module('../../session-open', () => ({
  ...realSessionOpen,
  openSession: async () => {
    opens += 1;
    if (opens === 1) {
      signalSessionRuntimeActive(SESSION_ID);
      return { stage: 'starting', sandbox: null, runtime_session_id: null };
    }
    return { stage: 'ready', sandbox: { external_id: 'ext-1', provider: 'platinum' }, runtime_session_id: 'oc-1' };
  },
}));
mock.module('../../lib/heal-session-token', () => ({ ...realHeal, healSupersededSessionToken: async () => {} }));
mock.module('../../lib/sandbox-env-sync', () => ({ ...realEnvSync, syncSandboxEnvForPrompt: async () => {} }));
mock.module('../../lib/sandbox-env-push', () => ({
  ...realEnvPush,
  prefetchPromptEnv: (projectId: string, sessionId: string, agent: string | null | undefined) => {
    prefetchCalls.push({ projectId, sessionId, agent });
  },
}));
mock.module('../../session-activity', () => ({ ...realActivity, recordSessionActivity: async () => {} }));

const { deliverAfterWake } = await import('../deliver');

/** Let the delivery's dynamic import of the prefetch settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function deliver(input: { turnAgent?: string | null; overrideAgent?: string; awake?: boolean }) {
  return deliverAfterWake({
    command: {
      sessionId: SESSION_ID,
      text: 'hi',
      ...(input.overrideAgent ? { overrides: { agent: input.overrideAgent } } : {}),
    } as never,
    session: { projectId: PROJECT_ID, accountId: 'acct-1' },
    sessionId: SESSION_ID,
    userId: 'user-1',
    ...(input.turnAgent !== undefined ? { turnAgent: input.turnAgent } : {}),
    awakeEarly: Promise.resolve(
      input.awake ? { stage: 'ready' as const, externalId: 'ext-1', runtimeSessionId: 'oc-1' } : null,
    ),
    sendPrompt: async () => true,
  });
}

beforeEach(() => {
  prefetchCalls = [];
  opens = 0;
});

describe('deliverAfterWake — the env prefetch names the agent the prompt body names', () => {
  test('a default-agent session (no override): the prefetch keys on the session agent the body carries', async () => {
    expect(await deliver({ turnAgent: 'mykortix' })).toBe('delivered');
    await settle();
    expect(prefetchCalls).toEqual([{ projectId: PROJECT_ID, sessionId: SESSION_ID, agent: 'mykortix' }]);
  });

  test('an explicit agent override: the prefetch keys on the turn agent, not on the raw override', async () => {
    expect(await deliver({ turnAgent: 'worker', overrideAgent: 'worker' })).toBe('delivered');
    await settle();
    expect(prefetchCalls.map((c) => c.agent)).toEqual(['worker']);
  });

  test('a box that is already awake takes the fast path: no prefetch', async () => {
    expect(await deliver({ turnAgent: 'mykortix', awake: true })).toBe('delivered');
    await settle();
    expect(prefetchCalls).toEqual([]);
    expect(opens).toBe(0);
  });
});
