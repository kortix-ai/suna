import { describe, expect, test } from 'bun:test';
import { readRequestOrigin } from './request-origin';

const headers = (values: Record<string, string>) => (name: string) => values[name] ?? null;

describe('readRequestOrigin', () => {
  test('reads the message, turn and thread ids', () => {
    expect(
      readRequestOrigin(
        headers({
          'x-kortix-message-id': 'msg_019a4f3c2b1dAbCdEfGhIjKlMn',
          'x-kortix-turn-id': 'msg_019a4f3c2a00ZyXwVuTsRqPoNm',
          'x-kortix-thread-id': 'ses_pi0123456789abcdef01234567',
        }),
      ),
    ).toEqual({
      messageId: 'msg_019a4f3c2b1dAbCdEfGhIjKlMn',
      turnId: 'msg_019a4f3c2a00ZyXwVuTsRqPoNm',
      threadId: 'ses_pi0123456789abcdef01234567',
    });
  });

  test('is undefined when no header is set', () => {
    expect(readRequestOrigin(headers({}))).toBeUndefined();
  });

  test('drops a value that is not an id', () => {
    expect(
      readRequestOrigin(headers({ 'x-kortix-message-id': 'msg 1; drop', 'x-kortix-turn-id': 'x'.repeat(129) })),
    ).toBeUndefined();
  });
});
