import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { readFileSync } from '@/i18n/test-source';

// Source assertions: the header needs the sidebar, router and query providers,
// and this app has no DOM harness for it. What is pinned is WHERE the two menu
// items live and what they call.
const header = readFileSync(
  fileURLToPath(new URL('./session-site-header.tsx', import.meta.url)),
  'utf8',
);
const chat = readFileSync(fileURLToPath(new URL('../session-chat.tsx', import.meta.url)), 'utf8');
const composer = readFileSync(
  fileURLToPath(new URL('../composer/composer.tsx', import.meta.url)),
  'utf8',
);

describe('session menu: the parent session and the session id', () => {
  test('a sub-session offers the way back to its parent from the session menu', () => {
    expect(header).toContain('{parentSession && (');
    expect(header).toContain('onClick={parentSession.onOpen}');
    expect(chat).toContain(
      '? { title: threadContext.parentTitle, onOpen: threadContext.onBackToParent }',
    );
  });

  test('the composer no longer draws the parent link', () => {
    expect(composer).not.toContain('threadContext');
    expect(chat).not.toContain('threadContext={threadContext}');
  });

  test('Copy session ID copies the Kortix session id, and says whether it worked', () => {
    expect(header).toContain('const copyableSessionId = projectSessionId ?? sessionId;');
    expect(header).toContain('copyToClipboard(copyableSessionId)');
    expect(header).toContain("successToast(tThreads('sessionIdCopied'))");
    expect(header).toContain("{tThreads('copySessionId')}");
  });
});
