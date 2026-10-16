/**
 * Who the project onboarding wizard is FOR.
 *
 * Two defects, one gate. Both were live for any plain project MEMBER invited
 * into someone else's project (#6522 moved the connector/customize reads out
 * of the member floor role, but the wizard never asked):
 *
 *  1. **It could not be dismissed.** Finishing AND skipping both call
 *     `onboarding.complete()` → `PATCH /projects/:id/onboarding`, which loads
 *     the project with `'write'` and 404s for a member. With no way to stamp
 *     the project onboarded, the wizard re-opened full-screen on every single
 *     project load, over a workspace they were invited into and can use.
 *  2. **Its Tools step 403'd out loud.** "Connect your tools" fetches
 *     `listConnectors`, which asserts `project.connector.read` — a bare
 *     "forbidden" toast over the whole flow.
 *
 * Source-pinned rather than rendered: the defect is which probe the component
 * consults and which comparison it makes, and both survive any DOM assertion.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const wizard = readFileSync(join(import.meta.dir, '..', 'project-onboarding-wizard.tsx'), 'utf8');
const code = wizard.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('project onboarding wizard — permission gate', () => {
  test('does not mount for a caller who cannot write the project', () => {
    expect(code).toContain(
      'const cannotSetUpProject = caps[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === false;',
    );
    expect(code).toContain("onboarding.status === 'pending' && !cannotSetUpProject");
    expect(code).toContain('if (!isPending) return null;');
  });

  // `=== false`, not `!== true`: an unresolved probe must leave the wizard
  // mounted, so the person who just created the project never watches it
  // appear a beat late.
  test('an in-flight write probe keeps the wizard, it does not suppress it', () => {
    expect(code).not.toContain('PROJECT_WRITE]?.allowed !== true');
    expect(code).not.toContain('PROJECT_WRITE]?.allowed === true');
  });

  // Mirror image on the connector leaf: shorten the wizard only on a RECEIVED
  // denial, so a slow probe never drops Tools/Slack for someone entitled.
  test('the connector steps drop only on a received denial', () => {
    expect(code).toContain(
      'const canReadConnectors = caps[PROJECT_ACTIONS.PROJECT_CONNECTOR_READ]?.allowed !== false;',
    );
    expect(code).toContain('buildSteps(connectorsEnabled, canReadConnectors)');
  });

  test('the connector list is not fetched for a caller denied the leaf', () => {
    const query = code.slice(
      code.indexOf('queryKey: qk.project.connectors(projectId)'),
      code.indexOf('const connectorSlugs'),
    );
    expect(query).toContain('enabled: isPending && canReadConnectors');
  });

  // This component mounts on every project load, so two singular `/effective`
  // GETs here are two on every load.
  test('both leaves ride the shared project-page batch', () => {
    expect(code).toContain('useProjectPageCans(projectId)');
    expect(code).not.toContain('useProjectCan(');
    expect(code).toContain('caps[PROJECT_ACTIONS.PROJECT_WRITE]');
    expect(code).toContain('caps[PROJECT_ACTIONS.PROJECT_CONNECTOR_READ]');
  });
});
