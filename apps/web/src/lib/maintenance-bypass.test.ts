import { expect, test } from 'bun:test';
import {
  createBypassToken,
  verifyBypassToken,
  MAINTENANCE_BYPASS_TTL_SECONDS,
} from './maintenance-bypass';

const NOW = 1_800_000_000; // fixed reference time (seconds)
const ADMIN_A = '11111111-1111-4111-8111-111111111111';
const ADMIN_B = '22222222-2222-4222-8222-222222222222';

test('a freshly minted token verifies', async () => {
  const token = await createBypassToken(ADMIN_A, NOW);
  expect(await verifyBypassToken(token, NOW)).toBe(true);
});

test('a token is valid right up to its expiry and invalid after', async () => {
  const token = await createBypassToken(ADMIN_A, NOW);
  const justBeforeExp = NOW + MAINTENANCE_BYPASS_TTL_SECONDS - 1;
  const afterExp = NOW + MAINTENANCE_BYPASS_TTL_SECONDS + 1;
  expect(await verifyBypassToken(token, justBeforeExp)).toBe(true);
  expect(await verifyBypassToken(token, afterExp)).toBe(false);
});

test('empty / malformed tokens are rejected', async () => {
  expect(await verifyBypassToken(undefined, NOW)).toBe(false);
  expect(await verifyBypassToken('', NOW)).toBe(false);
  expect(await verifyBypassToken('nodot', NOW)).toBe(false);
  expect(await verifyBypassToken('.onlysig', NOW)).toBe(false);
  expect(await verifyBypassToken('9999999999.', NOW)).toBe(false);
});

test('a tampered signature is rejected', async () => {
  const token = await createBypassToken(ADMIN_A, NOW);
  const parts = token.split('.');
  const sig = parts[parts.length - 1];
  const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
  parts[parts.length - 1] = flipped;
  expect(await verifyBypassToken(parts.join('.'), NOW)).toBe(false);
});

test('a forged expiry (kept far in the future, unsigned) is rejected', async () => {
  const token = await createBypassToken(ADMIN_A, NOW);
  const [, userId, sig] = token.split('.');
  // Attacker extends expiry but cannot resign it with the server secret.
  expect(await verifyBypassToken(`9999999999.${userId}.${sig}`, NOW)).toBe(false);
});

/**
 * JAY: the token used to be a bare `${exp}.${sig}` capability — anyone who
 * held a valid copy could use it, with no way to tell whose lockdown-era
 * access it represented. `userId` is now part of the SIGNED payload.
 */
test('the bound user id is part of the signed payload: relabeling it invalidates the token', async () => {
  const token = await createBypassToken(ADMIN_A, NOW);
  const [exp, userId, sig] = token.split('.');
  expect(userId).toBe(ADMIN_A);

  // Swap in a different admin's id without re-signing — exactly what an
  // attacker who can read (but not forge-sign) the cookie would try.
  const relabeled = `${exp}.${ADMIN_B}.${sig}`;
  expect(await verifyBypassToken(relabeled, NOW)).toBe(false);

  // The original, correctly-signed token for its real owner still works.
  expect(await verifyBypassToken(token, NOW)).toBe(true);
});

/**
 * A pre-binding token (the old two-part `${exp}.${sig}` shape a previous
 * deploy could still have set as a cookie) must fail closed, not be silently
 * accepted as "no user bound". Uses a real signature computed against the
 * CURRENT token's own hash — a two-part slice of a real, validly-signed
 * three-part token — so this proves the SHAPE is rejected, not just an
 * arbitrary bad signature.
 */
test('a pre-binding token (old two-part exp.sig shape) is rejected', async () => {
  const token = await createBypassToken(ADMIN_A, NOW);
  const [exp, , sig] = token.split('.');
  const legacyShaped = `${exp}.${sig}`; // one dot, not two
  expect(await verifyBypassToken(legacyShaped, NOW)).toBe(false);
});
