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
