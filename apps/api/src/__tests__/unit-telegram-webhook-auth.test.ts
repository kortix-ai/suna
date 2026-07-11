import { afterEach, describe, expect, test } from 'bun:test';
import {
  isKnownTelegramSenderForTest,
  telegramRequireUserIdentityForTest,
} from '../channels/telegram-webhook';

const originalRequireIdentity = process.env.TELEGRAM_REQUIRE_USER_IDENTITY;

afterEach(() => {
  if (originalRequireIdentity === undefined) {
    delete process.env.TELEGRAM_REQUIRE_USER_IDENTITY;
  } else {
    process.env.TELEGRAM_REQUIRE_USER_IDENTITY = originalRequireIdentity;
  }
});

describe('Telegram webhook sender binding', () => {
  test('requires bound sender identity by default', () => {
    delete process.env.TELEGRAM_REQUIRE_USER_IDENTITY;
    expect(telegramRequireUserIdentityForTest()).toBe(true);
  });

  test('allows explicit temporary legacy opt-out', () => {
    process.env.TELEGRAM_REQUIRE_USER_IDENTITY = 'false';
    expect(telegramRequireUserIdentityForTest()).toBe(false);
  });

  test('accepts only configured Telegram sender IDs', () => {
    const project = { metadata: { telegram: { allowedUserIds: ['12345'] } } };

    expect(
      isKnownTelegramSenderForTest(project, {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: 12345 },
        text: 'run',
      }),
    ).toBe(true);

    expect(
      isKnownTelegramSenderForTest(project, {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: 99999 },
        text: 'run',
      }),
    ).toBe(false);
  });

  test('fails closed when no allowlist or sender identity is present', () => {
    expect(
      isKnownTelegramSenderForTest(
        { metadata: {} },
        { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 12345 } },
      ),
    ).toBe(false);
    expect(
      isKnownTelegramSenderForTest(
        { metadata: { telegram: { allowedUserIds: ['12345'] } } },
        { message_id: 1, chat: { id: 1, type: 'private' } },
      ),
    ).toBe(false);
  });
});
