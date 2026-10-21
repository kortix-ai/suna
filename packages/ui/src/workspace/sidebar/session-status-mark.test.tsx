import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionStatusMark } from './session-status-mark';

const render = (status: Parameters<typeof SessionStatusMark>[0]['status']) =>
  renderToStaticMarkup(<SessionStatusMark status={status} />);

const dotCount = (html: string) => (html.match(/data-dot=""/g) ?? []).length;

describe('SessionStatusMark', () => {
  test('done is the dot ring filled with a core, never a check', () => {
    const html = render('done');
    expect(html).toContain('data-glyph="ready"');
    expect(dotCount(html)).toBe(8);
    expect(html).toContain('data-core');
    expect(html).not.toContain('M4 8.4');
  });

  test('running is a half arc with a fading three-dash trail, and does not animate', () => {
    const html = render('running');
    expect(html).toContain('data-glyph="working"');
    expect((html.match(/data-dash=""/g) ?? []).length).toBe(3);
    expect(html).not.toContain('data-core');
    expect(html).not.toContain('animate-');
  });

  test('needs-you is the yellow change-request glyph', () => {
    const html = render('needs-you');
    expect(html).toContain('data-glyph="review"');
    expect(html).toContain('var(--kortix-yellow)');
  });

  test('starting draws the same gray ring as stopped', () => {
    expect(render('starting')).toBe(render('stopped'));
  });
});
