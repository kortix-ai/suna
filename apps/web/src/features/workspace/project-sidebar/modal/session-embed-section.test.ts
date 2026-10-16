import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const section = readFileSync(
  fileURLToPath(new URL('./session-embed-section.tsx', import.meta.url)),
  'utf8',
);
const modal = readFileSync(
  fileURLToPath(new URL('./share-session-modal.tsx', import.meta.url)),
  'utf8',
);

/** The snippet builder, imported directly: its output is the contract. */
const { sessionEmbedSnippet } = await import('./session-embed-section');

describe('Share dialog embed section', () => {
  test('sources are the expected modules', () => {
    expect(section).toContain('export function SessionEmbedSection');
    expect(modal).toContain('export function ShareSessionModal');
  });

  test('sits in the Share dialog, gated on the same verdict as the in-team picker', () => {
    expect(modal).toContain(
      '<SessionEmbedSection projectId={projectId} sessionId={session.session_id} />',
    );
    // After the picker, inside the dialog body.
    expect(modal.indexOf('<SharingPicker')).toBeLessThan(modal.indexOf('<SessionEmbedSection'));
    expect(modal.indexOf('<SessionEmbedSection')).toBeLessThan(modal.indexOf('</ModalBody>'));
  });

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
    // Nothing minted, nothing granted: the embed carries no token, so there is
    // no share call in the section at all.
    expect(section).not.toContain('usePublicShareLink');
    expect(section).not.toContain('createSessionPublicShare');
    expect(section).not.toContain('transcript');
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

  test('copies the snippet itself, never the bare URL, with its own copied feedback', () => {
    expect(section).toContain('navigator.clipboard.writeText(snippet)');
    expect(section).toContain('onClick={() => void copy()}');
    expect(section).toContain('{copied ? (');
  });

  test('the copied flag resets on its own timer, cleared on unmount and before a restart', () => {
    expect(section).toContain('copiedTimer.current = setTimeout(() => setCopied(false)');
    expect(section).toContain('if (copiedTimer.current) clearTimeout(copiedTimer.current);');
    expect(section).toContain('useEffect(\n    () => () => {');
    expect(section).toContain('clearTimeout(copiedTimer.current)');
  });

  test('reads window.location.origin only in a browser (SSR renders a disabled button)', () => {
    expect(section).toContain("typeof window === 'undefined' ? null : window.location.origin");
  });
});
