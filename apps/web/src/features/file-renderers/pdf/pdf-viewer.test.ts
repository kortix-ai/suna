import { Rotation } from '@embedpdf/models';
import { ZoomMode } from '@embedpdf/plugin-zoom';
import { describe, expect, test } from 'bun:test';
import { getRotatedPageSize, isPdfCopyShortcut, selectPdfZoomLevel } from './pdf-viewer';

describe('getRotatedPageSize (page-1 size report → fitSplitPercent aspect input)', () => {
  const size = { width: 595, height: 842 }; // US Letter-ish, portrait

  test('Degree0 passes width/height through unchanged', () => {
    expect(getRotatedPageSize(size, Rotation.Degree0)).toEqual({ width: 595, height: 842 });
  });

  test('Degree180 passes width/height through unchanged', () => {
    expect(getRotatedPageSize(size, Rotation.Degree180)).toEqual({ width: 595, height: 842 });
  });

  test('Degree90 swaps width and height', () => {
    expect(getRotatedPageSize(size, Rotation.Degree90)).toEqual({ width: 842, height: 595 });
  });

  test('Degree270 swaps width and height', () => {
    expect(getRotatedPageSize(size, Rotation.Degree270)).toEqual({ width: 842, height: 595 });
  });
});

describe('selectPdfZoomLevel (the guard against a global default-zoom flip)', () => {
  test('fitOnOpen absent (undefined) keeps the numeric default', () => {
    expect(selectPdfZoomLevel(undefined, 1)).toBe(1);
  });

  test('fitOnOpen: false keeps the numeric default', () => {
    expect(selectPdfZoomLevel(false, 1)).toBe(1);
  });

  test('fitOnOpen: true switches to ZoomMode.FitPage, not a number', () => {
    const level = selectPdfZoomLevel(true, 1);
    expect(level).toBe(ZoomMode.FitPage);
    expect(typeof level).not.toBe('number');
  });
});

describe('isPdfCopyShortcut (Safari keydown without a key must not throw)', () => {
  test('key undefined returns false instead of throwing', () => {
    expect(isPdfCopyShortcut({ key: undefined, metaKey: true, ctrlKey: false })).toBe(false);
  });

  test('Cmd+C is the shortcut', () => {
    expect(isPdfCopyShortcut({ key: 'c', metaKey: true, ctrlKey: false })).toBe(true);
  });

  test('Ctrl+C is the shortcut (case-insensitive key)', () => {
    expect(isPdfCopyShortcut({ key: 'C', metaKey: false, ctrlKey: true })).toBe(true);
  });

  test('C without a modifier is not the shortcut', () => {
    expect(isPdfCopyShortcut({ key: 'c', metaKey: false, ctrlKey: false })).toBe(false);
  });

  test('another key with a modifier is not the shortcut', () => {
    expect(isPdfCopyShortcut({ key: 'v', metaKey: true, ctrlKey: false })).toBe(false);
  });

  test('empty key is not the shortcut', () => {
    expect(isPdfCopyShortcut({ key: '', metaKey: true, ctrlKey: false })).toBe(false);
  });
});
