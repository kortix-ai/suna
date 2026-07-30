import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PreviewFitProvider,
  usePreviewFit,
  isUsableIntrinsicSize,
  type IntrinsicSize,
} from './preview-fit';

describe('isUsableIntrinsicSize (the boundary report() filters through)', () => {
  test('a real decoded size is usable', () => {
    expect(isUsableIntrinsicSize({ width: 595, height: 842 })).toBe(true);
  });

  test.each([
    ['zero width', { width: 0, height: 842 }],
    ['negative width', { width: -1, height: 842 }],
    ['NaN width', { width: NaN, height: 842 }],
    ['infinite width', { width: Infinity, height: 842 }],
    ['zero height', { width: 595, height: 0 }],
    ['negative height', { width: 595, height: -1 }],
    ['NaN height', { width: 595, height: NaN }],
    ['infinite height', { width: 595, height: Infinity }],
  ])('%s is not usable', (_label, size) => {
    expect(isUsableIntrinsicSize(size as IntrinsicSize)).toBe(false);
  });
});

describe('usePreviewFit (no provider)', () => {
  test('returns null so a renderer outside the Easy panel no-ops', () => {
    function Probe() {
      const fit = usePreviewFit();
      return <span data-fit={fit === null ? 'null' : 'present'} />;
    }
    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain('data-fit="null"');
  });
});

describe('PreviewFitProvider / report', () => {
  test('a usable size reaches onMeasure with the same values', () => {
    const seen: IntrinsicSize[] = [];
    function Probe() {
      const fit = usePreviewFit();
      fit?.report({ width: 595, height: 842 });
      return null;
    }
    renderToStaticMarkup(
      <PreviewFitProvider onMeasure={(size) => seen.push(size)}>
        <Probe />
      </PreviewFitProvider>,
    );
    expect(seen).toEqual([{ width: 595, height: 842 }]);
  });

  test.each([
    ['zero width', { width: 0, height: 842 }],
    ['negative height', { width: 595, height: -1 }],
    ['NaN width', { width: NaN, height: 842 }],
    ['infinite height', { width: 595, height: Infinity }],
  ])('%s is dropped at the boundary — onMeasure never called', (_label, size) => {
    let called = false;
    function Probe() {
      const fit = usePreviewFit();
      fit?.report(size as IntrinsicSize);
      return null;
    }
    renderToStaticMarkup(
      <PreviewFitProvider
        onMeasure={() => {
          called = true;
        }}
      >
        <Probe />
      </PreviewFitProvider>,
    );
    expect(called).toBe(false);
  });
});
