import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  isUsableIntrinsicSize,
  PreviewFitProvider,
  usePreviewFit,
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

// ─── `reportUnmeasurable` says "never", where silence only says "not yet".
// A renderer that fetched fine and cannot render — a corrupt PDF, bytes that
// are not the image they claim — is the only thing that can tell those apart,
// and a consumer holding a width needs to know which it is. ──
describe('PreviewFitProvider / reportUnmeasurable', () => {
  test('reaches onUnmeasurable', () => {
    let failures = 0;
    function Probe() {
      const fit = usePreviewFit();
      fit?.reportUnmeasurable();
      return null;
    }
    renderToStaticMarkup(
      <PreviewFitProvider
        onMeasure={() => {}}
        onUnmeasurable={() => {
          failures += 1;
        }}
      >
        <Probe />
      </PreviewFitProvider>,
    );
    expect(failures).toBe(1);
  });

  test('never reaches onMeasure — a failure is not a measurement of zero', () => {
    let measured = false;
    function Probe() {
      const fit = usePreviewFit();
      fit?.reportUnmeasurable();
      return null;
    }
    renderToStaticMarkup(
      <PreviewFitProvider
        onMeasure={() => {
          measured = true;
        }}
        onUnmeasurable={() => {}}
      >
        <Probe />
      </PreviewFitProvider>,
    );
    expect(measured).toBe(false);
  });

  test('is a safe no-op when the consumer supplies no onUnmeasurable', () => {
    // A surface with no width to release opts out by omission; the renderers
    // call this unconditionally and must not throw there.
    function Probe() {
      const fit = usePreviewFit();
      fit?.reportUnmeasurable();
      return <span data-called="yes" />;
    }
    const html = renderToStaticMarkup(
      <PreviewFitProvider onMeasure={() => {}}>
        <Probe />
      </PreviewFitProvider>,
    );
    expect(html).toContain('data-called="yes"');
  });

  test('is absent entirely outside a provider, so renderers no-op', () => {
    // The `?.` in every renderer is what makes this inert on the Advanced
    // viewer, /workspaces previews, the modal and share pages.
    function Probe() {
      const fit = usePreviewFit();
      return <span data-fit={fit === null ? 'null' : 'present'} />;
    }
    expect(renderToStaticMarkup(<Probe />)).toContain('data-fit="null"');
  });
});
