import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');

describe('SessionChat external agent tasks', () => {
  test('registers the project session as an alias for the active OpenCode chat', () => {
    const registration = source.slice(
      source.indexOf('registerSender('),
      source.indexOf('return () => unregisterSender(sessionId)'),
    );
    expect(registration).toContain('projectSessionId ? [projectSessionId] : []');
  });

  test('queues tasks behind active turns, prompts, approvals, permissions, and existing queue work', () => {
    const registration = source.slice(
      source.indexOf('registerSender('),
      source.indexOf('return () => unregisterSender(sessionId)'),
    );
    expect(registration).toContain('shouldQueueInsteadOfSend');
    expect(registration).toContain('hasActiveQuestion');
    expect(registration).toContain('hasPendingApproval');
    expect(registration).toContain('pendingPermissions.length > 0');
    expect(registration).toContain('sessionQueue.pending.length');
    // The full expression, not a prefix of it. `sessionQueue.inFlightId` is a
    // substring of `sessionQueue.inFlightIds`, so the looser assertion kept
    // passing after this code stopped reading that field at all — a test that
    // cannot fail is worse than no test.
    expect(registration).toContain('queueInFlightIds.length > 0');
    expect(registration).toContain('handleQueueMessage(text)');
  });
});
