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

  test('moves a route-keyed prefill onto the chat id, where SessionChat reads it, every time one lands', () => {
    // Keyed on the waiting prefill: a second Quick Entry prompt for the session
    // already on screen lands after the chat resolved. Keyed on the ids alone,
    // it stayed under the route id and never sent.
    const from = page.indexOf('const routePrefillId');
    expect(from).toBeGreaterThan(-1);
    const effect = page.slice(from, page.indexOf('// ── Readiness benchmarking marks', from));
    expect(effect).toContain('useSessionComposerPrefillStore((s) => s.prefillBySession[sessionId]?.id)');
    expect(effect).toContain('useSessionComposerPrefillStore.getState().movePrefill(sessionId, chatSessionId);');
    expect(effect).toContain('}, [sessionId, chatSessionId, routePrefillId]);');
  });
});

describe('ComposerChatInput prefill with options', () => {
  const input = readFileSync(fileURLToPath(new URL('./composer-chat-input.tsx', import.meta.url)), 'utf8');

  test('applies agent, then model, then effort, one per commit, before the composer gets the prefill', () => {
    const effect = input.slice(input.indexOf('const optionsPrefill = '), input.indexOf('const deliveredPrefill'));
    const agent = effect.indexOf('optionsStepFor === 0 && wanted.agent');
    const model = effect.indexOf('optionsStepFor === 1 && wanted.model');
    const variant = effect.indexOf('optionsStepFor === 2');
    expect(agent).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(agent);
    expect(variant).toBeGreaterThan(model);
    // It waits for the agents and models to load, so a pick is never applied to an empty list.
    expect(effect).toContain('rosterLoaded');
    expect(input).toContain('const deliveredPrefill = optionsPrefill && optionsStepFor < 3 ? null : prefill;');
    expect(input).toContain('prefill={deliveredPrefill}');
  });
});
