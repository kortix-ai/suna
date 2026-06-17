/**
 * Unit tests for the stateless setup-link token codec.
 * Round-trip, expiry (410), tamper/wrong-key/wrong-prefix (404), and the
 * project-binding cross-check. Runs under dotenvx so config.API_KEY_SECRET
 * (the HKDF input) is present.
 */
import { describe, expect, test } from 'bun:test';
import { mintSetupLink, resolveSetupLink } from '../setup-links/token';
import { encryptProjectSecret } from '../projects/secrets';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

describe('setup-link token codec', () => {
  test('secret link round-trips with fields, scope, and minting user', () => {
    const { token, expiresAt } = mintSetupLink(
      PROJECT_A,
      {
        kind: 'secret',
        fields: [
          { name: 'APOLLO_API_KEY', label: 'Apollo', description: 'Settings → API' },
          { name: 'SMARTLEAD_API_KEY' },
        ],
        scope: 'runtime',
        uid: 'user-1',
      },
      { expiresInMinutes: 30 },
    );

    expect(token.startsWith('ksl_')).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const r = resolveSetupLink(token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projectId).toBe(PROJECT_A);
    expect(r.payload.kind).toBe('secret');
    if (r.payload.kind !== 'secret') return;
    expect(r.payload.fields.map((f) => f.name)).toEqual(['APOLLO_API_KEY', 'SMARTLEAD_API_KEY']);
    expect(r.payload.scope).toBe('runtime');
    expect(r.payload.uid).toBe('user-1');
  });

  test('connector link round-trips with slug, app, and mode', () => {
    const { token } = mintSetupLink(PROJECT_A, {
      kind: 'connector',
      slug: 'smartlead',
      app: 'smartlead',
      mode: 'per_user',
      uid: 'user-1',
    });
    const r = resolveSetupLink(token);
    expect(r.ok).toBe(true);
    if (!r.ok || r.payload.kind !== 'connector') throw new Error('expected connector');
    expect(r.payload.slug).toBe('smartlead');
    expect(r.payload.app).toBe('smartlead');
    expect(r.payload.mode).toBe('per_user');
  });

  test('scope defaults to runtime when omitted', () => {
    const { token } = mintSetupLink(PROJECT_A, { kind: 'secret', fields: [{ name: 'FOO_KEY' }] });
    const r = resolveSetupLink(token);
    if (!r.ok || r.payload.kind !== 'secret') throw new Error('expected secret');
    expect(r.payload.scope).toBe('runtime');
  });

  test('expired token resolves to 410', () => {
    // Build a token by hand with an exp in the past (mint clamps TTL ≥ 1 min).
    const payload = {
      kind: 'secret',
      fields: [{ name: 'FOO_KEY' }],
      scope: 'runtime',
      uid: null,
      exp: Date.now() - 1000,
      nonce: 'x',
      pid: PROJECT_A,
    };
    const envelope = encryptProjectSecret(PROJECT_A, JSON.stringify(payload));
    const token = 'ksl_' + Buffer.from(`${PROJECT_A}.${envelope}`, 'utf8').toString('base64url');
    const r = resolveSetupLink(token);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(410);
  });

  test('tampered envelope resolves to 404 (not 410)', () => {
    const { token } = mintSetupLink(PROJECT_A, { kind: 'secret', fields: [{ name: 'FOO_KEY' }] });
    // Flip the last base64url char of the wrapped token.
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const r = resolveSetupLink(tampered);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
  });

  test('a token cannot be decrypted by/for another project', () => {
    // Re-wrap PROJECT_A's envelope under PROJECT_B's id → wrong HKDF key → 404.
    const { token } = mintSetupLink(PROJECT_A, { kind: 'secret', fields: [{ name: 'FOO_KEY' }] });
    const decoded = Buffer.from(token.slice('ksl_'.length), 'base64url').toString('utf8');
    const envelope = decoded.slice(decoded.indexOf('.') + 1);
    const reWrapped = 'ksl_' + Buffer.from(`${PROJECT_B}.${envelope}`, 'utf8').toString('base64url');
    const r = resolveSetupLink(reWrapped);
    expect(r.ok).toBe(false);
  });

  test('garbage / wrong-prefix tokens resolve to 404', () => {
    for (const t of ['', 'not-a-token', 'kps_abc', 'ksl_!!!notbase64']) {
      const r = resolveSetupLink(t);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.status).toBe(404);
    }
  });
});
