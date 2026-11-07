import { describe, expect, it } from 'vitest';
import { readWorkflow } from '../src/fixtures/repo';

const workflows = ['ci.yml', 'deploy-dev.yml', 'security-scan.yml'] as const;

describe('app runtime workflow coverage', () => {
  // The title keeps the path these cases have always been reported under.
  it.each(workflows)('../../.github/workflows/%s watches the app runtime build inputs', (name) => {
    const workflow = readWorkflow(name);

    expect(workflow).toContain('apps/kortix-app-runtime/**');
  });

  it('forces every deployable service for a manual all-surface Dev recovery', () => {
    const workflow = readWorkflow('deploy-dev.yml');
    const normalize = workflow.slice(
      workflow.indexOf('      - name: Normalize outputs'),
      workflow.indexOf('      - name: Summary'),
    );
    // The manual `surface: all` dispatch forces every deployable service. It is
    // the `all)` case of the dispatch switch (was an if/else `else` before the
    // schedule+dispatch refactor added a `changed` default).
    const allSurface = normalize.slice(
      normalize.indexOf('              all)'),
      normalize.indexOf('              changed)'),
    );

    expect(allSurface).toContain('api=true');
    expect(allSurface).toContain('gateway=true');
    expect(allSurface).toContain('frontend=true');
    expect(allSurface).toContain('cli=true');
    expect(allSurface).toContain('terraform=true');
  });
});
