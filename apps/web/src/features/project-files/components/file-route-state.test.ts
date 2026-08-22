import { describe, expect, test } from 'bun:test';

import { requestedFilesRightPanel } from './file-route-state';

describe('files route state', () => {
  test('recognizes panels that can be opened from a deep link', () => {
    expect(requestedFilesRightPanel('proposed-changes')).toBe('proposed-changes');
    expect(requestedFilesRightPanel('history')).toBe('history');
    expect(requestedFilesRightPanel('unknown')).toBeNull();
    expect(requestedFilesRightPanel(null)).toBeNull();
  });
});
