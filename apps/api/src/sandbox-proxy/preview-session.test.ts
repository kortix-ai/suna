import { describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-secret-value-32-chars-long!!' } }));

const {
  appCookieHeader,
  PREVIEW_COOKIE,
  PREVIEW_COOKIE_PARTITIONED,
  PREVIEW_SESSION_TTL_SECONDS,
  mintPreviewSession,
  previewSessionCookies,
  readPreviewCookies,
  verifyPreviewSession,
} = await import('./preview-session');

const TARGET = { sandboxLabel: 'sbx-01m0g4hxcm32bx5r1gpyzdyc1h', port: 8081 };

const principal = {
  kind: 'principal' as const,
  sandboxLabel: TARGET.sandboxLabel,
  sandboxId: 'sbx_01M0G4HXCM32BX5R1GPYZDYC1H',
  port: TARGET.port,
  userId: 'user-1',
  callerSessionId: null,
  sandboxAuthored: false,
};

describe('mint / verify', () => {
  test('round-trips a principal grant', () => {
    const token = mintPreviewSession(principal, PREVIEW_SESSION_TTL_SECONDS);
    const session = verifyPreviewSession(token, TARGET);
    expect(session).toMatchObject({
      kind: 'principal',
      userId: 'user-1',
      port: 8081,
      // The canonical id rides along so a cookie hit skips the label lookup.
      sandboxId: 'sbx_01M0G4HXCM32BX5R1GPYZDYC1H',
    });
  });

  test('round-trips a public-share grant', () => {
    const token = mintPreviewSession(
      {
        kind: 'public_share',
        sandboxLabel: TARGET.sandboxLabel,
        sandboxId: 'sbx_01M0G4HXCM32BX5R1GPYZDYC1H',
        port: TARGET.port,
        shareId: 's1',
        mode: 'read',
      },
      900,
    );
    expect(verifyPreviewSession(token, TARGET)).toMatchObject({ kind: 'public_share', shareId: 's1' });
  });

  test('preserves the fields the forwarder authorizes on', () => {
    const token = mintPreviewSession(
      { ...principal, callerSessionId: 'session-9', sandboxAuthored: true },
      60,
    );
    expect(verifyPreviewSession(token, TARGET)).toMatchObject({
      callerSessionId: 'session-9',
      sandboxAuthored: true,
    });
  });

  test('a cookie for one preview is refused on another sandbox', () => {
    const token = mintPreviewSession(principal, 60);
    expect(verifyPreviewSession(token, { sandboxLabel: 'sbx-other', port: 8081 })).toBeNull();
  });

  test('a cookie for one port is refused on another port', () => {
    const token = mintPreviewSession(principal, 60);
    expect(verifyPreviewSession(token, { ...TARGET, port: 3000 })).toBeNull();
  });

  test('rejects a tampered payload', () => {
    const token = mintPreviewSession(principal, 60);
    const [, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...principal, userId: 'attacker', exp: 2_000_000_000 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyPreviewSession(`${forged}.${mac}`, TARGET)).toBeNull();
  });

  test('rejects an expired grant', () => {
    expect(verifyPreviewSession(mintPreviewSession(principal, -1), TARGET)).toBeNull();
  });

  test('rejects malformed input', () => {
    for (const bad of ['', 'a', 'a.b.c', 'not-base64.sig', null, undefined]) {
      expect(verifyPreviewSession(bad as string, TARGET)).toBeNull();
    }
  });
});

describe('cookies', () => {
  test('https serves an unpartitioned and a partitioned copy', () => {
    const cookies = previewSessionCookies('value', { secure: true, maxAgeSeconds: 100 });
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe(`${PREVIEW_COOKIE}=value; Path=/; HttpOnly; Max-Age=100; Secure; SameSite=None`);
    expect(cookies[1]).toContain('Partitioned');
    expect(cookies[1]).toStartWith(`${PREVIEW_COOKIE_PARTITIONED}=value;`);
  });

  test('an origin that cannot carry Secure falls back to one Lax cookie', () => {
    // Only reachable for a non-https, non-localhost preview host — a self-host
    // behind a plain-http reverse proxy. `SameSite=None` without `Secure` is
    // rejected outright, so Lax is the most that can be stored there.
    const cookies = previewSessionCookies('value', { secure: false, maxAgeSeconds: 100 });
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).not.toContain('SameSite=None');
    expect(cookies[0]).not.toContain('Secure');
  });

  test('reads the partitioned copy first so an embed wins over a stale tab cookie', () => {
    const header = `${PREVIEW_COOKIE}=plain; other=x; ${PREVIEW_COOKIE_PARTITIONED}=chips`;
    expect(readPreviewCookies(header)).toEqual(['chips', 'plain']);
  });

  test('reads nothing from an unrelated or absent Cookie header', () => {
    expect(readPreviewCookies(null)).toEqual([]);
    expect(readPreviewCookies('session=abc')).toEqual([]);
  });
});

describe('appCookieHeader', () => {
  test('forwards the app’s own cookies so a cookie-session app works', () => {
    expect(appCookieHeader('sessionid=abc; csrftoken=xyz')).toBe('sessionid=abc; csrftoken=xyz');
  });

  test('removes every Kortix cookie and keeps the rest', () => {
    const header = `sessionid=abc; ${PREVIEW_COOKIE}=k1; theme=dark; ${PREVIEW_COOKIE_PARTITIONED}=k2; __preview_session=k3`;
    expect(appCookieHeader(header)).toBe('sessionid=abc; theme=dark');
  });

  test('returns null when nothing is left to forward', () => {
    expect(appCookieHeader(`${PREVIEW_COOKIE}=k1; ${PREVIEW_COOKIE_PARTITIONED}=k2`)).toBeNull();
    expect(appCookieHeader('')).toBeNull();
    expect(appCookieHeader(null)).toBeNull();
  });

  test('keeps a cookie whose VALUE contains the reserved name', () => {
    expect(appCookieHeader(`ref=${PREVIEW_COOKIE}`)).toBe(`ref=${PREVIEW_COOKIE}`);
  });
});
