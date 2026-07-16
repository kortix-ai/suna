import { expect, test } from 'bun:test';
import {
  createBypassToken,
  verifyBypassToken,
  MAINTENANCE_BYPASS_TTL_SECONDS,
} from './maintenance-bypass';

const NOW = 1_800_000_000; // fixed reference time (seconds)

test('a freshly minted token verifies', async () => {
  const token = await createBypassToken(NOW);
  expect(await verifyBypassToken(token, NOW)).toBe(true);
});

test('a token is valid right up to its expiry and invalid after', async () => {
  const token = await createBypassToken(NOW);
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
  const token = await createBypassToken(NOW);
  const [exp, sig] = token.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
  expect(await verifyBypassToken(`${exp}.${flipped}`, NOW)).toBe(false);
});

test('a forged expiry (kept far in the future, unsigned) is rejected', async () => {
  const token = await createBypassToken(NOW);
  const sig = token.split('.')[1];
  // Attacker extends expiry but cannot resign it with the server secret.
  expect(await verifyBypassToken(`9999999999.${sig}`, NOW)).toBe(false);
});
