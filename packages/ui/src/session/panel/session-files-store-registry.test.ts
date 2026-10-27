import { describe, expect, test } from 'bun:test';

import { getSessionFilesStore, resetSessionFilesStores } from './session-files-store-registry';

describe('session file store registry', () => {
  test('keeps the selected file when a session remounts', () => {
    resetSessionFilesStores();
    const first = getSessionFilesStore('session-1');
    first.getState().openFile('/workspace/report.md');

    const remounted = getSessionFilesStore('session-1');

    expect(remounted).toBe(first);
    expect(remounted.getState().selectedFilePath).toBe('/workspace/report.md');
    expect(remounted.getState().view).toBe('viewer');
  });

  test('bounds inactive session file stores to twenty entries', () => {
    resetSessionFilesStores();
    const oldest = getSessionFilesStore('session-0');
    for (let index = 1; index <= 20; index += 1) {
      getSessionFilesStore(`session-${index}`);
    }

    expect(getSessionFilesStore('session-0')).not.toBe(oldest);
  });
});
