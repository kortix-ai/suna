import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./session-chat.tsx', import.meta.url), 'utf8');
const sessionPageSource = readFileSync(
  new URL('../../app/(app)/projects/[id]/sessions/[sessionId]/page.tsx', import.meta.url),
  'utf8',
);

test('the root session composer sends through the SDK useSession result', () => {
  expect(source).toContain('await sessionState.sendParts(mappedParts');
});

test('the frontend does not select a runtime transport', () => {
  expect(source).not.toContain('sessionState.runtimeTransport');
  expect(source).not.toMatch(/runtimeTransport\s*===\s*['"]acp['"]/);
});

test('the session page uses one SDK session hook for runtime session state', () => {
  expect(sessionPageSource).not.toContain('useCanonicalRuntimeSession(');
  expect(sessionPageSource).toContain('sessionState.runtimeSessions');
});
