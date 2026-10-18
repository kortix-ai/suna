import { describe, expect, test } from 'bun:test';

import { formatProjectPolicyLs } from '../commands/connectors.ts';

// KRTX-2527: `connectors policy <slug> set '*' ask` succeeded, and
// `connectors policy ls` seconds later printed "No explicit project
// policies." The project view carries per-connector rule counts next to the
// top-level list (same manifest read), and the print must show them instead
// of claiming nothing exists.

const view = {
  policies: [],
  defaultMode: 'allow_all' as const,
  errors: [],
  connectorRules: [{ slug: 'dogfood-mcp', rules: 1 }],
};

describe('formatProjectPolicyLs — per-connector rules (KRTX-2527)', () => {
  test('shows per-connector rules instead of "No explicit project policies"', () => {
    const out = formatProjectPolicyLs(view);
    expect(out).not.toContain('No explicit project policies');
    expect(out).toContain('dogfood-mcp');
    expect(out).toContain('1 rule');
  });

  test('still says so when neither list nor connector rules exist', () => {
    const out = formatProjectPolicyLs({
      policies: [],
      defaultMode: 'allow_all',
      errors: [],
      connectorRules: [],
    });
    expect(out).toContain('No explicit project policies');
  });

  test('lists top-level policies as before, plus the per-connector section', () => {
    const out = formatProjectPolicyLs({
      policies: [{ match: '*.delete*', action: 'block' }],
      defaultMode: 'risk',
      errors: [],
      connectorRules: [{ slug: 'dogfood-mcp', rules: 2 }],
    });
    expect(out).toContain('*.delete*');
    expect(out).toContain('block');
    expect(out).toContain('dogfood-mcp');
    expect(out).toContain('2 rules');
  });

  test('tolerates an older gateway that sends no connectorRules', () => {
    const out = formatProjectPolicyLs({
      policies: [],
      defaultMode: 'allow_all',
      errors: [],
    });
    expect(out).toContain('No explicit project policies');
  });
});
