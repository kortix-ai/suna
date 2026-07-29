import { expect, test } from 'bun:test';

import { adoptManagedAcpRuntime } from './adoption';

test('warm-seed adoption replaces seed boot state and starts the selected ACP harness', async () => {
  const bootState = {
    repoMaterializationError: null,
    timeline: [],
    initialOpenCodeSessionRequired: true,
    acpHarness: null,
    acpServerId: null,
    acpRuntimeReady: false,
    acpRuntimeError: null,
  };
  const calls: unknown[] = [];

  await adoptManagedAcpRuntime(
    bootState,
    {
      getOrCreate: async (serverId, harness) => {
        calls.push({ serverId, harness });
        return {} as never;
      },
    },
    {
      KORTIX_RUNTIME_HARNESS: 'pi',
      KORTIX_ACP_SERVER_ID: 'project-session-1',
      KORTIX_SESSION_ID: 'project-session-1',
    },
  );

  expect(calls).toEqual([{ serverId: 'project-session-1', harness: 'pi' }]);
  expect(bootState).toMatchObject({
    initialOpenCodeSessionRequired: false,
    acpHarness: 'pi',
    acpServerId: 'project-session-1',
    acpRuntimeReady: true,
    acpRuntimeError: null,
  });
});
