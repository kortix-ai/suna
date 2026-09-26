import { describe, expect, test } from 'bun:test';

import { createPendingPickRecovery, type PendingLike } from './pending-picker-result';

describe('createPendingPickRecovery', () => {
  test('recovers the camera asset as an image file', async () => {
    const recovery = createPendingPickRecovery(async () => ({
      canceled: false,
      assets: [{ uri: 'file:///cache/a.jpg', mimeType: 'image/jpeg' }],
    }));
    const files = await recovery.consume();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ uri: 'file:///cache/a.jpg', isImage: true });
  });

  test('null, canceled, and error results recover nothing', async () => {
    const cases: (PendingLike | null)[] = [
      null,
      { canceled: true, assets: null },
      { code: 'E_PICKER', message: 'boom' },
    ];
    for (const result of cases) {
      const recovery = createPendingPickRecovery(async () => result);
      expect(await recovery.consume()).toEqual([]);
    }
  });

  test('only the first consumer receives the result', async () => {
    let calls = 0;
    const recovery = createPendingPickRecovery(async () => {
      calls += 1;
      return {
        canceled: false,
        assets: [{ uri: 'file:///cache/a.jpg', mimeType: 'image/jpeg' }],
      };
    });
    const first = await recovery.consume();
    const second = await recovery.consume();
    expect(calls).toBe(1);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
