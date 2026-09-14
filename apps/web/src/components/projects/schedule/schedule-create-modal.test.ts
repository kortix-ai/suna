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
