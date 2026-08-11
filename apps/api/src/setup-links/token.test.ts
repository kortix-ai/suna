import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';

mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-pepper' } }));

const { clampTtlMinutes, mintSetupLink, resolveSetupLink } = await import('./token');

const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555';
const T0 = new Date('2026-08-07T12:00:00.000Z');
const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

function mintSecret(expiresInMinutes?: number) {
  return mintSetupLink(
    WORKSPACE_ID,
    { kind: 'secret', fields: [{ name: 'DRATA_API_KEY' }], scope: 'runtime', sid: 'sess-1' },
    expiresInMinutes === undefined ? undefined : { expiresInMinutes },
  );
}

afterEach(() => {
  setSystemTime();
});

describe('setup-link TTLs', () => {
  test('secret links default to 7 days so an async human can still open them', () => {
    setSystemTime(T0);
    const { expiresAt } = mintSecret();
    expect(expiresAt).toBe(T0.getTime() + 7 * DAY_MINUTES * MINUTE_MS);
  });

  test('connector links default to 7 days', () => {
    setSystemTime(T0);
    const { expiresAt } = mintSetupLink(WORKSPACE_ID, { kind: 'connector', slug: 'smartlead' });
    expect(expiresAt).toBe(T0.getTime() + 7 * DAY_MINUTES * MINUTE_MS);
  });

  test('approval links keep the 24h decision window', () => {
    setSystemTime(T0);
    const { expiresAt } = mintSetupLink(WORKSPACE_ID, { kind: 'approval', executionId: 'exec-1' });
    expect(expiresAt).toBe(T0.getTime() + DAY_MINUTES * MINUTE_MS);
  });

  test('explicit TTL is honored within bounds', () => {
    expect(clampTtlMinutes(60)).toBe(60);
    expect(clampTtlMinutes(14 * DAY_MINUTES)).toBe(14 * DAY_MINUTES);
  });

  test('explicit TTL clamps to the 1min..30d bounds', () => {
    expect(clampTtlMinutes(0)).toBe(1);
    expect(clampTtlMinutes(-5)).toBe(1);
    expect(clampTtlMinutes(365 * DAY_MINUTES)).toBe(30 * DAY_MINUTES);
    expect(clampTtlMinutes(Number.NaN)).toBe(7 * DAY_MINUTES);
    expect(clampTtlMinutes(null)).toBe(7 * DAY_MINUTES);
  });
});

describe('resolveSetupLink', () => {
  test('a live token resolves with its sealed payload', () => {
    setSystemTime(T0);
    const { token } = mintSecret();
    const resolved = resolveSetupLink(token);
    expect(resolved.ok).toBe(true);
    if (resolved.ok && resolved.payload.kind === 'secret') {
      expect(resolved.workspaceId).toBe(WORKSPACE_ID);
      expect(resolved.payload.fields.map((f) => f.name)).toEqual(['DRATA_API_KEY']);
      expect(resolved.payload.sid).toBe('sess-1');
    }
  });

  test('an expired token returns 410 with expiry-specific wording, never a generic 404', () => {
    setSystemTime(T0);
    const { token } = mintSecret(1);
    setSystemTime(new Date(T0.getTime() + 3 * MINUTE_MS));
    const resolved = resolveSetupLink(token);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.status).toBe(410);
      expect(resolved.error).toContain('expired');
    }
  });

  test('a token within the 60s clock-skew buffer still resolves', () => {
    setSystemTime(T0);
    const { token } = mintSecret(1);
    setSystemTime(new Date(T0.getTime() + MINUTE_MS + 30_000));
    expect(resolveSetupLink(token).ok).toBe(true);
  });

  test('a truncated token (mangled in copy/paste transit) returns 404 invalid', () => {
    setSystemTime(T0);
    const { token } = mintSecret();
    const resolved = resolveSetupLink(token.slice(0, token.length - 8));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.status).toBe(404);
    }
  });

  test('garbage and missing tokens return 404 invalid', () => {
    for (const bad of [undefined, null, '', 'ksl_', 'not-a-token', `ksl_${'A'.repeat(40)}`]) {
      const resolved = resolveSetupLink(bad as string | undefined | null);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.status).toBe(404);
    }
  });
});
