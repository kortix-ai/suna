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

  test('an external task takes the SAME single send path, and the server orders it', () => {
    // REWRITTEN. This used to assert that an external sender re-derived the
    // queue-vs-send decision locally — from `isBusy`, the pending count, the
    // in-flight ids, and the approval/permission gates. Every one of those is a
    // guess about server state made in a browser tab, and two tabs guessed
    // differently. The decision now lives in the server's admission gate, which
    // reads the same turn authority `GET .../turn` serves from, so an external
    // task is simply SENT: it becomes a durable row, and the server delivers it
    // when the session can take it.
    const registration = source.slice(
      source.indexOf('registerSender('),
      source.indexOf('return () => unregisterSender(sessionId)'),
    );
    expect(registration).toContain('await handleSend(text)');
    expect(registration).toContain("return 'sent'");
    expect(registration).not.toContain('handleQueueMessage');
    // And there is no local queue anywhere in the component for a future
    // caller to reach for.
    expect(source).not.toContain('shouldQueueInsteadOfSend');
    expect(source).not.toContain('useMessageQueueStore');
  });
});
