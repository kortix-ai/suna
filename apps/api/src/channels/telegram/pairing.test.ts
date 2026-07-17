import { describe, expect, test } from 'bun:test';
import {
  TELEGRAM_PAIRING_TTL_MS,
  addTelegramAllowedUser,
  generateTelegramPairingCode,
  normalizeTelegramPairingCode,
  removeTelegramAllowedUser,
  telegramAllowedUserIds,
  telegramAllowedUserProfiles,
  telegramAllowedUsers,
  telegramPairingMatches,
} from './pairing';

const NOW = new Date('2026-07-13T12:00:00.000Z');
const LIVE = new Date(NOW.getTime() + TELEGRAM_PAIRING_TTL_MS).toISOString();

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('generateTelegramPairingCode', () => {
  test('formats 8 alphabet chars as XXXX-XXXX', () => {
    const code = generateTelegramPairingCode(bytes(0, 1, 2, 3, 4, 5, 6, 7));
    expect(code).toBe('ABCD-EFGH');
  });

  test('maps bytes through &31 so every byte value lands in the alphabet', () => {
    const code = generateTelegramPairingCode(bytes(255, 32, 63, 64, 95, 96, 128, 159));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(code).not.toMatch(/[IO01]/);
  });

  test('rejects fewer than 8 random bytes', () => {
    expect(() => generateTelegramPairingCode(bytes(1, 2, 3))).toThrow('8 random bytes');
  });
});

describe('normalizeTelegramPairingCode', () => {
  test('uppercases and strips separators', () => {
    expect(normalizeTelegramPairingCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeTelegramPairingCode('AB CD ef.gh')).toBe('ABCDEFGH');
  });
});

describe('telegramPairingMatches', () => {
  const pairing = { code: 'ABCD-EFGH', expiresAt: LIVE };

  test('accepts the exact code and forgiving formats', () => {
    expect(telegramPairingMatches(pairing, 'ABCD-EFGH', NOW)).toBe(true);
    expect(telegramPairingMatches(pairing, 'abcdefgh', NOW)).toBe(true);
    expect(telegramPairingMatches(pairing, ' abcd efgh ', NOW)).toBe(true);
  });

  test('rejects wrong, truncated, and empty codes', () => {
    expect(telegramPairingMatches(pairing, 'ABCD-EFGJ', NOW)).toBe(false);
    expect(telegramPairingMatches(pairing, 'ABCD', NOW)).toBe(false);
    expect(telegramPairingMatches(pairing, '', NOW)).toBe(false);
  });

  test('rejects expired and malformed expiry', () => {
    const after = new Date(Date.parse(LIVE) + 1);
    expect(telegramPairingMatches(pairing, 'ABCD-EFGH', after)).toBe(false);
    expect(
      telegramPairingMatches({ code: 'ABCD-EFGH', expiresAt: 'not-a-date' }, 'ABCD-EFGH', NOW),
    ).toBe(false);
  });
});

describe('allowlist metadata helpers', () => {
  test('telegramAllowedUserIds normalizes to strings and tolerates junk', () => {
    expect(telegramAllowedUserIds(null)).toEqual([]);
    expect(telegramAllowedUserIds({})).toEqual([]);
    expect(telegramAllowedUserIds({ telegram: { allowedUserIds: 'nope' } })).toEqual([]);
    expect(telegramAllowedUserIds({ telegram: { allowedUserIds: [777, '888', ''] } })).toEqual([
      '777',
      '888',
    ]);
  });

  test('addTelegramAllowedUser appends, dedupes, and preserves other metadata', () => {
    const metadata = {
      source: 'telegram',
      telegram: { allowedUserIds: ['777'], other: 'kept' },
    };
    const merged = addTelegramAllowedUser(metadata, 888);
    expect(telegramAllowedUserIds(merged)).toEqual(['777', '888']);
    expect(merged.source).toBe('telegram');
    expect((merged.telegram as Record<string, unknown>).other).toBe('kept');
    expect(telegramAllowedUserIds(addTelegramAllowedUser(merged, '888'))).toEqual(['777', '888']);
  });

  test('addTelegramAllowedUser builds the structure from empty metadata', () => {
    expect(telegramAllowedUserIds(addTelegramAllowedUser(null, 42))).toEqual(['42']);
  });

  test('removeTelegramAllowedUser reports whether anything changed', () => {
    const metadata = { telegram: { allowedUserIds: ['777', '888'] } };
    const hit = removeTelegramAllowedUser(metadata, '777');
    expect(hit.removed).toBe(true);
    expect(telegramAllowedUserIds(hit.metadata)).toEqual(['888']);
    const miss = removeTelegramAllowedUser(metadata, '999');
    expect(miss.removed).toBe(false);
    expect(telegramAllowedUserIds(miss.metadata)).toEqual(['777', '888']);
  });
});

describe('allowlist profile capture', () => {
  test('addTelegramAllowedUser stores name/@username beside the id', () => {
    const merged = addTelegramAllowedUser(null, 6925313519, {
      firstName: 'Ivan',
      lastName: 'Ino',
      username: 'ivan',
      pairedAt: '2026-07-16T00:00:00.000Z',
    });
    expect(telegramAllowedUserIds(merged)).toEqual(['6925313519']);
    expect(telegramAllowedUsers(merged)).toEqual([
      {
        id: '6925313519',
        firstName: 'Ivan',
        lastName: 'Ino',
        username: 'ivan',
        pairedAt: '2026-07-16T00:00:00.000Z',
      },
    ]);
  });

  test('telegramAllowedUsers renders a bare id (legacy, no profile) gracefully', () => {
    const meta = { telegram: { allowedUserIds: ['777', '888'] } };
    expect(telegramAllowedUsers(meta)).toEqual([{ id: '777' }, { id: '888' }]);
  });

  test('re-pair keeps the original pairedAt and only fills blank fields', () => {
    const first = addTelegramAllowedUser(null, 777, {
      username: 'ivan',
      pairedAt: '2026-01-01T00:00:00.000Z',
    });
    // A later backfill supplies a name but must not overwrite pairedAt.
    const second = addTelegramAllowedUser(first, 777, {
      firstName: 'Ivan',
      pairedAt: '2026-09-09T00:00:00.000Z',
    });
    expect(telegramAllowedUsers(second)).toEqual([
      { id: '777', firstName: 'Ivan', username: 'ivan', pairedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  test('removeTelegramAllowedUser drops the profile too (no orphan)', () => {
    const meta = addTelegramAllowedUser(null, 777, { username: 'ivan' });
    const { metadata, removed } = removeTelegramAllowedUser(meta, '777');
    expect(removed).toBe(true);
    expect(telegramAllowedUserProfiles(metadata)).toEqual({});
    expect(telegramAllowedUsers(metadata)).toEqual([]);
  });

  test('adding an id with no profile does not fabricate an empty profile map entry', () => {
    const meta = addTelegramAllowedUser(null, 777);
    expect(telegramAllowedUserProfiles(meta)).toEqual({});
    expect(telegramAllowedUsers(meta)).toEqual([{ id: '777' }]);
  });
});
