import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('staging secret synchronization', () => {
  it('preserves the existing staging bundle and uses dev only for first creation', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/deploy-staging.yml'),
      'utf8',
    );

    const preserveStart = workflow.indexOf('if aws secretsmanager describe-secret --secret-id kortix-staging-env');
    const payloadStart = workflow.indexOf('payload="$(jq -cn');
    const preservationBlock = workflow.slice(preserveStart, payloadStart);

    expect(preserveStart).toBeGreaterThan(-1);
    expect(payloadStart).toBeGreaterThan(preserveStart);
    expect(preservationBlock).toContain('--secret-id kortix-staging-env');
    expect(preservationBlock).toContain('staging_secret_exists=true');
    expect(preservationBlock).toContain('else');
    expect(preservationBlock).toContain('--secret-id kortix-dev-env');
    expect(preservationBlock).toContain('staging_secret_exists=false');
    expect(workflow).toContain('if [ "$staging_secret_exists" = true ]; then');
  });
});
