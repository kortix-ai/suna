// `wakeSandbox` starts a box AT THE PROVIDER. The reaper stops a box at the
// provider BEFORE it writes the row, and it only ever examines rows whose
// status is 'active' — so a wake that ignores the deadline resurrects a box
// the reaper just killed, the DB heal (which does check the deadline) refuses
// to return the row to 'active', and the result is a box that is RUNNING,
// unreapable and unbilled. That is strictly worse than the zombie this design
// deletes, which is why the provider start carries the same gate as the heal.
//
// `mock.module` is process-global in bun, so this lives in its own file.
import { describe, expect, mock, test } from 'bun:test';
import * as realProviders from '../platform/providers';
import * as realPreviewOwnership from '../shared/preview-ownership';
import * as realKortixUserContext from '../shared/kortix-user-context';

let ensureRunningCalls: string[] = [];
let deadlineAt: Date | null = new Date(Date.now() + 60 * 60_000);

mock.module('../config', () => ({ config: {} }));
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  resolvePreviewUserContext: async () => null,
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure lands
// in whatever unrelated file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.
// Overriding only what this file needs keeps new exports working by default.
mock.module('../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
  encodeKortixUserContext: () => '',
}));
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    async ensureRunning(externalId: string) {
      ensureRunningCalls.push(externalId);
    },
  }),
}));

// Two selects run: loadSandbox (the record) then the deadline probe. Both are
// served from the same chainable stub; the deadline probe is the one that
// resolves to a row carrying `deadlineAt`.
mock.module('../shared/db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      const isDeadlineProbe = 'deadlineAt' in (fields ?? {});
      const rows = isDeadlineProbe
        ? deadlineAt === null
          ? []
          : [{ deadlineAt }]
        : [
            {
              sandboxId: 'sb-1',
              externalId: 'ext-1',
              sessionId: 'sess-1',
              agentName: null,
              workspaceId: 'proj-1',
              accountId: 'acct-1',
              provider: 'daytona',
              status: 'stopped',
              baseUrl: null,
              config: {},
            },
          ];
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    },
  },
}));

const { wakeSandbox } = await import('./backend');

function reset(nextDeadline: Date | null) {
  ensureRunningCalls = [];
  deadlineAt = nextDeadline;
}

describe('wakeSandbox — a provider start obeys the deadline', () => {
  test('wakes a box whose deadline is still live', async () => {
    reset(new Date(Date.now() + 60 * 60_000));

    await wakeSandbox('ext-1');

    expect(ensureRunningCalls).toEqual(['ext-1']);
  });

  test('REFUSES to wake a box whose deadline has passed', async () => {
    // A reaper-stopped box has an expired deadline by construction. Starting it
    // here would leave it running at the provider while the row stays 'stopped'
    // — invisible to the reaper, whose candidate set is status='active' only.
    reset(new Date(Date.now() - 60_000));

    await wakeSandbox('ext-1');

    expect(ensureRunningCalls).toEqual([]);
  });

  test('refuses when the deadline row cannot be read, rather than failing open', async () => {
    reset(null);

    await wakeSandbox('ext-1');

    expect(ensureRunningCalls).toEqual([]);
  });
});
