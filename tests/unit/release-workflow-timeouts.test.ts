import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/qa-release.yml'),
  'utf8',
);

function step(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

describe('release workflow timeout contract', () => {
  it('gives the complete live API suite enough time to finish', () => {
    expect(step('API flow suite')).toContain('timeout-minutes: 90');
  });

  it('bounds AWS report authentication independently of the release gate', () => {
    const awsAuth = step('AWS auth for report publish');

    expect(awsAuth).toContain('timeout-minutes: 2');
    expect(awsAuth).toContain('action-timeout-s: 60');
    expect(awsAuth).toContain('retry-max-attempts: 3');
  });
});
