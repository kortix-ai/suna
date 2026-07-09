import { describe, expect, test } from 'bun:test';
import {
  chunkTelegramText,
  renderWorkingStatus,
  sessionDeepLink,
  telegramHtml,
} from './format';

describe('telegramHtml', () => {
  test('converts the markdown agents actually write', () => {
    const html = telegramHtml('## Result\n**3 issues** fixed in `parser.ts` — see [the diff](https://kortix.com/d/1). *nice*');
    expect(html).toContain('<b>Result</b>');
    expect(html).toContain('<b>3 issues</b>');
    expect(html).toContain('<code>parser.ts</code>');
    expect(html).toContain('<a href="https://kortix.com/d/1">the diff</a>');
    expect(html).toContain('<i>nice</i>');
  });

  test('escapes HTML so user/agent content cannot inject tags', () => {
    const html = telegramHtml('use <script>alert(1)</script> & compare a < b');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<script>');
  });

  test('fenced code blocks become <pre> and stay unstyled inside', () => {
    const html = telegramHtml('Before\n```ts\nconst a = "**not bold**";\n```\nAfter');
    expect(html).toContain('<pre>const a = &quot;**not bold**&quot;;</pre>'.replace('&quot;', '"').replace('&quot;', '"'));
    expect(html).toContain('<pre>');
    expect(html).not.toContain('<pre><b>');
    expect(html).toContain('Before');
    expect(html).toContain('After');
  });

  test('non-http(s) link syntax stays literal text', () => {
    const html = telegramHtml('[x](javascript:alert(1))');
    expect(html).not.toContain('<a');
    expect(html).toContain('[x](javascript:alert(1))');
  });

  test('blockquotes render', () => {
    expect(telegramHtml('> quoted line')).toContain('<blockquote>quoted line</blockquote>');
  });
});

describe('chunkTelegramText', () => {
  test('short text is a single chunk', () => {
    expect(chunkTelegramText('hello')).toEqual(['hello']);
  });

  test('long text splits at paragraph boundaries, all under the limit', () => {
    const para = `${'x'.repeat(900)}\n\n`;
    const text = para.repeat(6).trim(); // ~5400 chars
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    // Nothing lost.
    expect(chunks.join('\n\n').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  test('a wall of text with no separators still hard-splits safely', () => {
    const chunks = chunkTelegramText('y'.repeat(9000));
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  });
});

describe('renderWorkingStatus', () => {
  test('empty steps → the placeholder', () => {
    expect(renderWorkingStatus([])).toBe('⏳ <i>Working on it…</i>');
  });

  test('done steps get checks, the live one an hourglass, titles escaped', () => {
    const s = renderWorkingStatus([
      { title: 'Read <config>', done: true },
      { title: 'Fix the parser', done: false },
    ]);
    expect(s).toBe('✅ Read &lt;config&gt;\n⏳ Fix the parser');
  });

  test('long runs collapse to the tail with an "earlier steps" note', () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ title: `s${i}`, done: true }));
    const s = renderWorkingStatus(steps);
    expect(s).toContain('…3 earlier steps');
    expect(s).not.toContain('s0');
    expect(s).toContain('s8');
  });
});

describe('sessionDeepLink', () => {
  test('builds the dashboard URL from an https base', () => {
    expect(sessionDeepLink('https://kortix.com/', 'p1', 's1')).toBe(
      'https://kortix.com/projects/p1/sessions/s1',
    );
  });

  test('refuses http/empty bases (Telegram rejects such buttons)', () => {
    expect(sessionDeepLink('http://localhost:8008', 'p1', 's1')).toBeNull();
    expect(sessionDeepLink('', 'p1', 's1')).toBeNull();
    expect(sessionDeepLink(undefined, 'p1', 's1')).toBeNull();
  });
});
