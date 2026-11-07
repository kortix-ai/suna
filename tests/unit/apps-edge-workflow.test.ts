import { describe, expect, it } from 'vitest';
import { readWorkflow } from '../src/fixtures/repo';

const workflows = ['configure-apps-edge.yml', 'deploy-dev.yml'] as const;

describe('Apps edge workflow Wrangler contract', () => {
  // The title keeps the path these cases have always been reported under.
  it.each(workflows)('../../.github/workflows/%s uses Wrangler 4.34 secret-list syntax', (name) => {
    const workflow = readWorkflow(name);

    expect(workflow).toContain('wrangler@4.34.0 secret list --format json');
    expect(workflow).not.toContain('wrangler@4.34.0 secret list --json');
  });
});
