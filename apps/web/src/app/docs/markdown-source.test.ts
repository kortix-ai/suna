import { describe, expect, test } from 'bun:test';

import { createMarkdownSource } from './markdown-source';

function response(text: string, ok = true, status = 200) {
  return Promise.resolve({ ok, status, text: () => Promise.resolve(text) });
}

describe('createMarkdownSource', () => {
  test('does not fetch until asked', () => {
    let calls = 0;
    const source = createMarkdownSource('/markdown/docs/index.md', () => {
      calls += 1;
      return response('# Kortix');
    });

    expect(source.peek()).toBeNull();
    expect(calls).toBe(0);
  });

  test('one request serves every overlapping caller', async () => {
    // A hover, a focus and a press can all land before the first response —
    // three requests for one string would be worse than the bug being fixed.
    let calls = 0;
    const source = createMarkdownSource('/markdown/docs/index.md', () => {
      calls += 1;
      return response('# Kortix');
    });

    const [a, b, c] = await Promise.all([source.load(), source.load(), source.load()]);

    expect(calls).toBe(1);
    expect([a, b, c]).toEqual(['# Kortix', '# Kortix', '# Kortix']);
  });

  test('once loaded, the text is there without a request', async () => {
    // This is the whole point: by the time the button is clicked, `peek()`
    // answers, and the clipboard write happens inside the click with no await
    // in front of it.
    let calls = 0;
    const source = createMarkdownSource('/markdown/docs/index.md', () => {
      calls += 1;
      return response('# Kortix');
    });

    await source.load();

    expect(source.peek()).toBe('# Kortix');
    await source.load();
    expect(calls).toBe(1);
  });

  test('a failed response rejects and is not remembered', async () => {
    // A reader whose first press hit a dead connection must be able to press
    // again; a cached rejection would hand them the same failure forever.
    let calls = 0;
    const source = createMarkdownSource('/markdown/docs/index.md', () => {
      calls += 1;
      return calls === 1 ? response('', false, 500) : response('# Kortix');
    });

    await expect(source.load()).rejects.toThrow('500');
    expect(source.peek()).toBeNull();

    expect(await source.load()).toBe('# Kortix');
    expect(calls).toBe(2);
  });

  test('a rejected fetch is not remembered either', async () => {
    let calls = 0;
    const source = createMarkdownSource('/markdown/docs/index.md', () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : response('# Kortix');
    });

    await expect(source.load()).rejects.toThrow('offline');
    expect(await source.load()).toBe('# Kortix');
  });
});
