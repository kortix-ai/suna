import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/deploy-dev.yml'),
  'utf8',
);

function jobBody(name: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`missing workflow job: ${name}`);
  const next = workflow.slice(start + 2).search(/^  [a-z][a-z0-9-]+:/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 2 + next);
}

describe('Deploy Dev self-host channel promotions', () => {
  for (const [job, prerequisites] of [
    ['promote-dev-channel-api', ['tag-api', 'deploy-api-ecs']],
    ['promote-dev-channel-gateway', ['tag-gateway', 'verify-gateway-dev-parity']],
    ['promote-dev-channel-frontend', ['build-frontend', 'verify-web-dev']],
  ] as const) {
    test(`${job} runs after unrelated surface jobs skip`, () => {
      const body = jobBody(job);
      expect(body).toContain('if: ${{ always()');
      for (const prerequisite of prerequisites) {
        expect(body).toContain(`needs.${prerequisite}.result == 'success'`);
      }
    });
  }
});
