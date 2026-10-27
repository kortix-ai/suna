import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import { parse as parseYaml } from 'yaml';
import { validateManifest } from '../index';
import { KORTIX_JSON_SCHEMA, KORTIX_V1_JSON_SCHEMA } from '../json-schema';

const ajv = new Ajv2020({ strict: false, allErrors: true });
const schema = ajv.compile(KORTIX_JSON_SCHEMA as Record<string, unknown>);

function manifest(agentSets: string, connectorExtra = '', version = 2): string {
  return `
kortix_version: ${version}
default_agent: support
agents:
  support:
    connectors: [gmail]
${agentSets}
connectors:
  - slug: gmail
    provider: composio
    app: gmail
    policies:
      - match: delete_*
        action: block
    policy_sets:
      read_only:
        description: Read and search, never send
        policies:
          - match: send_*
            action: block
      outreach:
        policies:
          - match: send_email
            action: require_approval
            conditions:
              - arg: to
                match: "*@example.com"
${connectorExtra}
`;
}

function issuesAt(text: string) {
  const result = validateManifest(text, 'yaml');
  return {
    errors: result.issues.filter((i) => i.severity === 'error').map((i) => i.path),
    warnings: result.issues.filter((i) => i.severity === 'warning').map((i) => i.path),
  };
}

describe('policy sets in the manifest', () => {
  test('a valid set and an agent that names it validate in v2 and the JSON schema', () => {
    const text = manifest('    policy_sets:\n      gmail: read_only');
    expect(issuesAt(text).errors).toEqual([]);
    expect(schema(parseYaml(text))).toBe(true);
  });

  test('an unknown set name is an error naming the entry', () => {
    const { errors } = issuesAt(manifest('    policy_sets:\n      gmail: nope'));
    expect(errors).toContain('agents.support.policy_sets.gmail');
  });

  test('the reserved name "base" is an error as a set and as an agent value', () => {
    const asValue = issuesAt(manifest('    policy_sets:\n      gmail: base'));
    expect(asValue.errors).toContain('agents.support.policy_sets.gmail');
    const asSet = issuesAt(manifest('', '      base:\n        policies: []'));
    expect(asSet.errors).toContain('connectors[0].policy_sets.base');
  });

  test('an ungranted or undeclared connector is a warning, not an error', () => {
    const ungranted = manifest('    policy_sets:\n      gmail: read_only').replace('connectors: [gmail]', 'connectors: []');
    const r1 = issuesAt(ungranted);
    expect(r1.warnings).toContain('agents.support.policy_sets.gmail');
    expect(r1.errors.filter((p) => p.includes('policy_sets'))).toEqual([]);
    const r2 = issuesAt(manifest('    policy_sets:\n      stripe: read_only'));
    expect(r2.warnings).toContain('agents.support.policy_sets.stripe');
  });

  test('a bad set name and an unknown set key are errors', () => {
    const { errors } = issuesAt(manifest('', '      Bad Name:\n        policies: []\n      ok:\n        rules: []'));
    expect(errors).toContain('connectors[0].policy_sets.Bad Name');
    expect(errors).toContain('connectors[0].policy_sets.ok.rules');
  });

  test('v3 accepts policy_sets on an agent', () => {
    const text = `
kortix_version: 3
default_agent: support
agents:
  support:
    prompt: Help.
    connectors: [gmail]
    policy_sets:
      gmail: read_only
connectors:
  - slug: gmail
    provider: composio
    app: gmail
    policy_sets:
      read_only:
        policies:
          - match: send_*
            action: block
`;
    expect(issuesAt(text).errors).toEqual([]);
  });

  test('channel connectors cannot carry sets', () => {
    const text = `
kortix_version: 2
agents:
  support:
    connectors: [team]
connectors:
  - slug: team
    provider: channel
    platform: slack
    policy_sets:
      quiet:
        policies: []
`;
    expect(issuesAt(text).errors).toContain('connectors[0].policy_sets');
  });
});

describe('v1 JSON Schema', () => {
  test('refuses connectors[].policy_sets, as the validator does', () => {
    const v1 = new Ajv2020({ strict: false, allErrors: true }).compile(KORTIX_V1_JSON_SCHEMA as Record<string, unknown>);
    const base = { kortix_version: 1, connectors: [{ slug: 'gmail', provider: 'composio', app: 'gmail' }] };
    expect(v1(base)).toBe(true);
    const withSets = structuredClone(base) as Record<string, any>;
    withSets.connectors[0].policy_sets = { read_only: { policies: [] } };
    expect(v1(withSets)).toBe(false);
  });
});
