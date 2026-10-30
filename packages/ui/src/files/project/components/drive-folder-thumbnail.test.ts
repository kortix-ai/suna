import { describe, expect, test } from 'bun:test';

import { folderLines } from './drive-folder-thumbnail';

describe('folder pages fill with the item count', () => {
  test('front page first, one line per item, up to five', () => {
    expect(folderLines(0)).toEqual({ front: 0, back: 0 });
    expect(folderLines(1)).toEqual({ front: 1, back: 0 });
    expect(folderLines(5)).toEqual({ front: 5, back: 0 });
  });

  test('then the back page, one line per ten more items', () => {
    expect(folderLines(6)).toEqual({ front: 5, back: 1 });
    expect(folderLines(10)).toEqual({ front: 5, back: 1 });
    expect(folderLines(21)).toEqual({ front: 5, back: 2 });
    expect(folderLines(55)).toEqual({ front: 5, back: 5 });
    expect(folderLines(5000)).toEqual({ front: 5, back: 5 });
  });
});
