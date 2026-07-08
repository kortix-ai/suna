import { describe, test, expect } from 'bun:test';
import { validateManifest } from '../index';

// Regression: a manifest section-SHAPE error must reference the syntax that fits
// the FILE'S format. A YAML author who writes `triggers:` as a map/scalar must
// be told to use a YAML list — never "use `[[triggers]]`" (TOML table-array),
// and vice-versa. Each `*Bad` input below malforms exactly one section (a
// single table/map where a list is required) so the list-shape validator fires.
describe('manifest error messages are format-aware (YAML vs TOML)', () => {
  const cases = [
    {
      name: 'agents',
      toml: '[[agents]]',
      yamlBad: `kortix_version: 1\nagents:\n  name: test`,
      tomlBad: `kortix_version = 1\n[agents]\nname = "test"`,
    },
    {
      name: 'connectors',
      toml: '[[connectors]]',
      yamlBad: `kortix_version: 1\nconnectors:\n  name: test`,
      tomlBad: `kortix_version = 1\n[connectors]\nname = "test"`,
    },
    {
      name: 'triggers',
      toml: '[[triggers]]',
      yamlBad: `kortix_version: 1\ntriggers:\n  slug: test`,
      tomlBad: `kortix_version = 1\n[triggers]\nslug = "test"`,
    },
    {
      name: 'sandbox.templates',
      toml: '[[sandbox.templates]]',
      yamlBad: `kortix_version: 1\nsandbox:\n  templates:\n    slug: test`,
      tomlBad: `kortix_version = 1\n[sandbox.templates]\nslug = "test"`,
    },
  ];

  const errText = (input: string, fmt: 'yaml' | 'toml') =>
    validateManifest(input, fmt)
      .issues.filter((i) => i.severity === 'error')
      .map((i) => i.message)
      .join(' | ');

  for (const c of cases) {
    test(`${c.name} — YAML shape error says "list", never the TOML ${c.toml}`, () => {
      const e = errText(c.yamlBad, 'yaml');
      expect(e).toContain('must be a list');
      expect(e).not.toContain(c.toml);
    });

    test(`${c.name} — TOML shape error references ${c.toml}`, () => {
      const e = errText(c.tomlBad, 'toml');
      expect(e).toContain(c.toml);
    });
  }
});
