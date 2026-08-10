import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pageSource = readFileSync(
  resolve(import.meta.dir, 'app/(app)/workspaces/[id]/sessions/[sessionId]/page.tsx'),
  'utf8',
);
const chatSource = readFileSync(
  resolve(import.meta.dir, 'features/session/session-chat.tsx'),
  'utf8',
);

describe('workspace session engine boundary', () => {
  test('the page mounts the complete SDK session engine', () => {
    expect(pageSource).not.toContain('chatEngine: false');
    expect(pageSource).toContain('sessionState={session}');
  });

  test('SessionChat consumes supplied SDK state without a second engine', () => {
    expect(chatSource).toContain("useSessionSync(sessionState ? '' : sessionId)");
    expect(chatSource).toContain('enabled: !sessionState && isActiveSessionTab');
    expect(chatSource).not.toContain('const client = getClient()');
    expect(chatSource).toContain('sessionState?.runCommand');
    expect(chatSource).not.toContain('@/stores/opencode-compaction-store');
    expect(chatSource).toContain('sessionState?.isCompacting ?? false');
  });

  test('SessionChat preserves hydrated content after a runtime lookup miss', () => {
    expect(chatSource).toContain('resolveSessionContentState({');
    expect(chatSource).toContain('hasMessages,');
    expect(chatSource).not.toContain(
      'const isNotFound = !session && sessionResolved && !optimisticPrompt',
    );
  });
});
