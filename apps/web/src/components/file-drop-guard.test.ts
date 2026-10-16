import { describe, expect, test } from 'bun:test';

import { refuseStrayFileDrag } from './file-drop-guard';

function drag(types: string[], defaultPrevented = false) {
  const event = {
    defaultPrevented,
    dataTransfer: { types, dropEffect: 'copy' } as unknown as DataTransfer,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

describe('refuseStrayFileDrag', () => {
  test('cancels a file drag no drop zone claimed, with the no-drop cursor', () => {
    const event = drag(['Files']);
    refuseStrayFileDrag(event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.dataTransfer.dropEffect).toBe('none');
  });

  test('leaves a drag a drop zone already claimed alone', () => {
    const event = drag(['Files'], true);
    refuseStrayFileDrag(event);
    expect(event.dataTransfer.dropEffect).toBe('copy');
  });

  test('leaves a text or link drag alone, so editors keep their native drop', () => {
    const event = drag(['text/plain', 'text/uri-list']);
    refuseStrayFileDrag(event);
    expect(event.defaultPrevented).toBe(false);
    expect(event.dataTransfer.dropEffect).toBe('copy');
  });
});
