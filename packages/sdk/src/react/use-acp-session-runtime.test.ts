import { expect, test } from 'bun:test';

import { cancelAcpSession } from './use-acp-session-runtime';

test('ACP cancellation propagates the controller rejection', async () => {
  const failure = new Error('cancel failed');
  await expect(
    cancelAcpSession({
      cancel: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
});
