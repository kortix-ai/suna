import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => ({ raw: (key: string) => key }),
}));

const { WhenWebhook } = await import('./when-webhook');
const { initialDraft } = await import('./trigger-composer-logic');

function render(error?: string) {
  return renderToStaticMarkup(
    createElement(WhenWebhook, { draft: initialDraft({ kind: 'webhook' }), patch: () => {}, error }),
  );
}

function attrsOf(html: string, id: string) {
  const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
  return (name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

// KRTX-2816: Create with an empty signing key showed only a hint a reader
// could not tie to the field, and nothing said the key is required.
describe('WhenWebhook signing key', () => {
  test('is marked required, and a shown error is tied to the field it describes', () => {
    const html = render('Add a signing key so only your app can start this.');
    const attr = attrsOf(html, 'trigger-signing-key');
    expect(attr('aria-required')).toBe('true');
    expect(attr('aria-invalid')).toBe('true');
    const describedBy = attr('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`<p[^>]*role="alert"[^>]*id="${describedBy}"|<p[^>]*id="${describedBy}"[^>]*role="alert"`));
  });

  test('without an error it is still required and describes nothing stale', () => {
    const attr = attrsOf(render(), 'trigger-signing-key');
    expect(attr('aria-required')).toBe('true');
    expect(attr('aria-describedby')).toBeUndefined();
  });
});
