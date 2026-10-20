import { expect, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { bundledLanguages } from 'shiki/langs';
import { HighlightedCode } from './code-block';
import { __testing, highlightAsync, SHIKI_THEME_LIGHT } from './shiki-highlighter';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

test('oversized bounded code renders whole as plain text; unbounded highlights it, toggle-back included', async () => {
  await highlightAsync('warm', 'text', SHIKI_THEME_LIGHT);
  __testing.shikiCache.clear();
  expect(__testing.loadedLangs.has('zig')).toBe(false);
  const original = bundledLanguages.zig;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const importer = spyOn(bundledLanguages, 'zig').mockImplementation(async () => {
    await gate;
    return original();
  });
  const code = '// padding\n'.repeat(5001) + '// MOUNTED_TAIL';
  expect(code.indexOf('MOUNTED_TAIL')).toBeGreaterThan(50_000);
  let mounted: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      mounted = create(<HighlightedCode code={code} language="zig" />);
    });
    // Over the limit and bounded: no highlight, the whole text renders plain.
    expect(mounted?.root.findByType('code').props.dangerouslySetInnerHTML).toBeUndefined();
    expect(mounted?.root.findByType('code').children).toEqual([code]);
    await act(async () => {
      mounted?.update(<HighlightedCode code={code} language="zig" unbounded />);
    });
    expect(importer).toHaveBeenCalled();
    await act(async () => {
      release();
      await highlightAsync(code, 'zig', SHIKI_THEME_LIGHT, { unbounded: true });
    });
    const full = mounted?.root.findByType('code').props.dangerouslySetInnerHTML.__html;
    expect(full).toContain('MOUNTED_TAIL');
    await act(async () => {
      mounted?.update(<HighlightedCode code={code} language="zig" />);
    });
    expect(mounted?.root.findByType('code').props.dangerouslySetInnerHTML).toBeUndefined();
    expect(mounted?.root.findByType('code').children).toEqual([code]);
    await act(async () => {
      mounted?.update(<HighlightedCode code={code} language="zig" unbounded />);
    });
    expect(mounted?.root.findByType('code').props.dangerouslySetInnerHTML.__html).toBe(full);
  } finally {
    release();
    await act(async () => {
      mounted?.unmount();
    });
    importer.mockRestore();
    // The grammars stay in the module-level loadedLangs singleton otherwise,
    // and the highlighter suite asserts they were never loaded.
    __testing.loadedLangs.delete('zig');
    __testing.shikiCache.clear();
  }
});

test('retained async HTML cannot satisfy the opposite mode while its grammar reloads', async () => {
  await highlightAsync('warm', 'text', SHIKI_THEME_LIGHT);
  const original = bundledLanguages.ruby;
  const gates: Array<() => void> = [];
  const importer = spyOn(bundledLanguages, 'ruby').mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    return original();
  });
  const code = '# padding\n'.repeat(5001) + '# RETAINED_TAIL';
  let mounted: ReactTestRenderer | undefined;
  try {
    __testing.loadedLangs.delete('ruby');
    __testing.shikiCache.clear();
    await act(async () => {
      mounted = create(<HighlightedCode code={code} language="ruby" unbounded />);
    });
    await act(async () => {
      gates.shift()?.();
      await highlightAsync(code, 'ruby', SHIKI_THEME_LIGHT, { unbounded: true });
    });
    expect(mounted?.root.findByType('code').props.dangerouslySetInnerHTML.__html).toContain(
      'RETAINED_TAIL',
    );
    // Simulate a grammar/cache becoming unavailable. The component still holds
    // its completed unbounded result; the bounded mode must not reuse it.
    __testing.shikiCache.clear();
    __testing.loadedLangs.delete('ruby');
    await act(async () => {
      mounted?.update(<HighlightedCode code={code} language="ruby" />);
    });
    expect(mounted?.root.findByType('code').props.dangerouslySetInnerHTML).toBeUndefined();
    expect(mounted?.root.findByType('code').children).toEqual([code]);
  } finally {
    for (const release of gates) release();
    await act(async () => {
      mounted?.unmount();
    });
    importer.mockRestore();
    __testing.loadedLangs.delete('ruby');
    __testing.shikiCache.clear();
  }
});
