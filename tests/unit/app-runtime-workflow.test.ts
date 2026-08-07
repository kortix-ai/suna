import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPaths = [
  '../../.github/workflows/ci.yml',
  '../../.github/workflows/deploy-dev.yml',
  '../../.github/workflows/security-scan.yml',
] as const;

describe('app runtime workflow coverage', () => {
  it.each(workflowPaths)('%s watches the app runtime build inputs', (workflowPath) => {
    const workflow = readFileSync(resolve(import.meta.dirname, workflowPath), 'utf8');

    expect(workflow).toContain('apps/kortix-app-runtime/**');
  });
});
