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
    expect(step('Run deployed REST and CLI flows')).toContain('timeout-minutes: 100');
  });

  it('gives browser journeys an independent timeout', () => {
    expect(step('Run deployed browser journeys')).toContain('timeout-minutes: 45');
  });
});
