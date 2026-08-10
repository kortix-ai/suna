import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');

describe('SessionChat external agent tasks', () => {
  test('registers the workspace session as an alias for the active OpenCode chat', () => {
    const registration = source.slice(
      source.indexOf('registerSender('),
      source.indexOf('return () => unregisterSender(sessionId)'),
    );
    expect(registration).toContain('workspaceSessionId ? [workspaceSessionId] : []');
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
    expect(registration).toContain('sessionQueue.inFlightId');
    expect(registration).toContain('handleQueueMessage(text)');
  });
});
