import { Rotation } from '@embedpdf/models';
import { ZoomMode } from '@embedpdf/plugin-zoom';
import { describe, expect, test } from 'bun:test';
import { getRotatedPageSize, selectPdfZoomLevel } from './pdf-viewer';

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
