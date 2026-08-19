import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPaths = [
  '../../.github/workflows/configure-apps-edge.yml',
  '../../.github/workflows/deploy-dev.yml',
] as const;

describe('Apps edge workflow Wrangler contract', () => {
  it.each(workflowPaths)('%s uses Wrangler 4.34 secret-list syntax', (workflowPath) => {
    const workflow = readFileSync(resolve(import.meta.dirname, workflowPath), 'utf8');

    expect(workflow).toContain('wrangler@4.34.0 secret list --format json');
    expect(workflow).not.toContain('wrangler@4.34.0 secret list --json');
  });
});
