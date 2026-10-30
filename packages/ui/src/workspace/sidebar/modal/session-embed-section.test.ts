import { describe, expect, test } from 'bun:test';
import { sessionEmbedSnippet } from './session-embed-section';

describe('sessionEmbedSnippet', () => {
  test('the snippet embeds the actual session page (KRTX-2358 direction)', () => {
    const snippet = sessionEmbedSnippet(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'https://kortix.com',
    );
    // The real session page URL, on the app origin — not a token-gated viewer
    // or widget route.
    expect(snippet).toBe(
      '<iframe src="https://kortix.com/projects/11111111-1111-4111-8111-111111111111/sessions/22222222-2222-4222-8222-222222222222" style="height:640px;width:100%;border:0;border-radius:12px" title="Kortix session" loading="lazy"></iframe>',
    );
  });

  test('the snippet is injection-proof by construction', () => {
    // A session id with a quote cannot escape the src attribute: the builder
    // percent-encodes both ids, and the title attribute is a fixed string.
    const hostile = sessionEmbedSnippet('p"onload=alert(1)', 's"><script>', 'https://kortix.com');
    expect(hostile).toContain('%22');
    expect(hostile).toContain('%3E%3Cscript%3E');
    expect(hostile).toContain('title="Kortix session"');
    expect(hostile).not.toContain('"><script>');
  });

  test('empty input cannot produce a usable snippet', () => {
    expect(sessionEmbedSnippet('', 's', 'https://kortix.com')).toBeNull();
    expect(sessionEmbedSnippet('p', '', 'https://kortix.com')).toBeNull();
    expect(sessionEmbedSnippet('p', 's', '')).toBeNull();
  });
});
