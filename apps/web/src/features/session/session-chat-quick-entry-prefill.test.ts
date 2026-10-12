import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { fileURLToPath } from 'node:url';

// Source assertion, like session-chat-queued-retry-id.test.ts: SessionChat has
// no DOM harness here, and the wiring under test is one field reaching the
// composer. The composer's own submit is covered in composer-logic.test.ts.
const source = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');

describe('session page prefill', () => {
  test('forwards submit, so a desktop Quick Entry prompt sends in the picked session', () => {
    const from = source.indexOf('const composerPrefill = useMemo(');
    expect(from).toBeGreaterThan(-1);
    const memo = source.slice(from, source.indexOf('}, [sessionPrefill]);', from));
    expect(memo).toContain('...(sessionPrefill.submit ? { submit: true } : {})');
  });
});

describe('session route page', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../../app/[locale]/(app)/projects/[id]/sessions/[sessionId]/page.tsx', import.meta.url)),
    'utf8',
  );

  test('moves a route-keyed prefill onto the chat id, where SessionChat reads it', () => {
    const from = page.indexOf('migrateStash(sessionId, chatSessionId);');
    expect(from).toBeGreaterThan(-1);
    expect(page.slice(from, from + 400)).toContain(
      'useSessionComposerPrefillStore.getState().movePrefill(sessionId, chatSessionId);',
    );
  });
});
