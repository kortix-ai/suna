import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const modalSource = readFileSync(join(import.meta.dir, 'schedule-create-modal.tsx'), 'utf8');

/**
 * Comments stripped, same convention as `new-workspace-errors.test.ts`.
 * Guards the webhook wizard's signing-secret contract from the caller side:
 * trigger validation (apps/api/src/projects/lib/webhook-secret-policy.ts)
 * accepts a secret_env only when it is delivered as broker to the connector
 * consumer, so the wizard must never create it without an explicit policy.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const modal = stripComments(modalSource);

describe('schedule-create-modal: webhook signing secret delivery', () => {
  test('auto-created signing key is upserted with broker/connector delivery', () => {
    expect(modal).toContain(`strategy: 'broker'`);
    expect(modal).toContain(`consumer: 'connector'`);
  });

  test('the upsert targets the same project as the trigger being created', () => {
    expect(modal).toContain('upsertProjectSecret(projectId');
  });

  test('no runtime-delivery signing key remains in the wizard', () => {
    expect(modal).not.toMatch(/strategy:\s*'runtime'/);
  });
});

describe('schedule-create-modal: the signing key is cryptographically random', () => {
  // CodeQL js/insecure-randomness (alert #6471). `generateSigningKey` fell back
  // to `Math.random().toString(36)` when `crypto.getRandomValues` was missing.
  // That key SIGNS webhook payloads, so a predictable one is forgeable — and
  // V8's Math.random is xorshift128+, recoverable from a handful of outputs.
  // `crypto.getRandomValues` exists in every browser back to IE11 and in
  // Node >= 19, so the fallback was dead code that could only ever weaken the
  // key. Refusing is the correct failure: no key at all is safer than one an
  // attacker can reproduce.
  test('the generator never falls back to Math.random', () => {
    const generator = modal.slice(
      modal.indexOf('function generateSigningKey'),
      modal.indexOf('function normalizeSecretName'),
    );
    expect(generator.length).toBeGreaterThan(0);
    expect(generator).not.toContain('Math.random');
  });

  test('it uses crypto.getRandomValues over 32 bytes', () => {
    const generator = modal.slice(
      modal.indexOf('function generateSigningKey'),
      modal.indexOf('function normalizeSecretName'),
    );
    expect(generator).toContain('crypto.getRandomValues');
    expect(generator).toContain('Uint8Array(32)');
  });

  test('an environment without a CSPRNG is refused, not silently downgraded', () => {
    const generator = modal.slice(
      modal.indexOf('function generateSigningKey'),
      modal.indexOf('function normalizeSecretName'),
    );
    expect(generator).toContain('throw new Error');
  });
});
