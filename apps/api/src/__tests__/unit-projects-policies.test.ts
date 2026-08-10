/**
 * Top-level `policies:` + `policy:` parser for kortix.yaml. Mirrors the
 * connectors parser shape — collects bad entries into `errors` instead of
 * throwing — and validates the engine vocabulary (action, default_mode).
 */
import { describe, expect, test } from 'bun:test';
import {
  type WorkspacePolicySpec,
  extractWorkspacePolicies,
  workspacePoliciesToTomlEntries,
  workspacePolicySettingsToToml,
} from '../workspaces/policies';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../workspaces/triggers';

function parseFrom(body: string) {
  const m = parseManifestString(
    `kortix_version: ${KNOWN_SCHEMA_VERSION}\nproject:\n  name: t\n${body}`,
    'yaml',
    'kortix.yaml',
  );
  return extractWorkspacePolicies(m);
}

describe('extractWorkspacePolicies — happy paths', () => {
  test('empty manifest → empty list + allow_all default + no errors', () => {
    const r = parseFrom('');
    expect(r.policies).toEqual([]);
    expect(r.settings.defaultMode).toBe('allow_all');
    expect(r.errors).toEqual([]);
  });

  test('parses top-level policies: in declared order', () => {
    const r = parseFrom(`
policies:
  - match: "*.delete*"
    action: block
  - match: stripe.*
    action: require_approval
  - match: "*"
    action: always_run
`);
    expect(r.policies).toEqual([
      { match: '*.delete*', action: 'block' },
      { match: 'stripe.*', action: 'require_approval' },
      { match: '*', action: 'always_run' },
    ]);
    expect(r.errors).toEqual([]);
  });

  test('policy.default_mode = "risk" overrides allow_all default', () => {
    const r = parseFrom(`
policy:
  default_mode: risk
`);
    expect(r.settings.defaultMode).toBe('risk');
    expect(r.errors).toEqual([]);
  });

  test('policy.default_mode = "allow_all" parses explicitly', () => {
    const r = parseFrom(`
policy:
  default_mode: allow_all
`);
    expect(r.settings.defaultMode).toBe('allow_all');
  });
});

describe('extractWorkspacePolicies — error cases', () => {
  test('policies as a mapping is rejected (must be a list)', () => {
    const r = parseFrom(`
policies:
  match: "*"
  action: block
`);
    // A mapping, not an array — parser rejects.
    expect(r.policies).toEqual([]);
    expect(r.errors[0]?.error).toMatch(/`policies` must be an array of tables/);
  });

  test('entry missing match', () => {
    const r = parseFrom(`
policies:
  - action: block
`);
    expect(r.policies).toEqual([]);
    expect(r.errors[0]?.error).toMatch(/missing `match`/);
  });

  test('entry with invalid action', () => {
    const r = parseFrom(`
policies:
  - match: "*"
    action: skip
`);
    expect(r.policies).toEqual([]);
    expect(r.errors[0]?.error).toMatch(/action.*must be one of/);
  });

  test('default_mode with invalid value', () => {
    const r = parseFrom(`
policy:
  default_mode: yolo
`);
    expect(r.settings.defaultMode).toBe('allow_all'); // unchanged default
    expect(r.errors[0]?.error).toMatch(/default_mode must be one of/);
  });

  test('partial failures still collect good entries', () => {
    const r = parseFrom(`
policies:
  - match: good
    action: block
  - match: ""
    action: block
  - match: "*"
    action: always_run
`);
    expect(r.policies).toEqual([
      { match: 'good', action: 'block' },
      { match: '*', action: 'always_run' },
    ]);
    expect(r.errors).toHaveLength(1);
  });
});

describe('round-trip serializers', () => {
  test('workspacePoliciesToTomlEntries preserves match + action', () => {
    const policies: WorkspacePolicySpec[] = [
      { match: '*.delete*', action: 'block' },
      { match: '*', action: 'always_run' },
    ];
    expect(workspacePoliciesToTomlEntries(policies)).toEqual([
      { match: '*.delete*', action: 'block' },
      { match: '*', action: 'always_run' },
    ]);
  });

  test('workspacePolicySettingsToToml omits the default to keep the file clean', () => {
    expect(workspacePolicySettingsToToml({ defaultMode: 'allow_all' })).toBeNull();
    expect(workspacePolicySettingsToToml({ defaultMode: 'risk' })).toEqual({ default_mode: 'risk' });
  });
});

/**
 * Argument CONDITIONS on a project policy — the authoring half of the
 * arg-level guardrail. The engine could enforce these before this path existed,
 * but `conditions` was dropped between the manifest and the DB, so an
 * allow-list was unwritable (and, because sync is delete-then-insert from the
 * manifest, a hand-inserted row was erased on the next sync).
 */
describe('extractWorkspacePolicies — argument conditions', () => {
  test('parses an allow-list rule with a regex condition', () => {
    const { policies, errors } = parseFrom(
      [
        'policies:',
        '  - match: gmail.send_email',
        '    action: require_approval',
        '    conditions:',
        '      - arg: to',
        '        match: /^(owner|admin)@example\\.com$/',
        '  - match: gmail.send_email',
        '    action: block',
      ].join('\n'),
    );

    expect(errors).toEqual([]);
    expect(policies).toEqual([
      {
        match: 'gmail.send_email',
        action: 'require_approval',
        conditions: [{ arg: 'to', match: '/^(owner|admin)@example\\.com$/' }],
      },
      { match: 'gmail.send_email', action: 'block' },
    ]);
  });

  test('keeps negate and a nested arg path', () => {
    const { policies, errors } = parseFrom(
      [
        'policies:',
        '  - match: slack.post',
        '    action: block',
        '    conditions:',
        '      - arg: message.channel',
        '        match: general',
        '        negate: true',
      ].join('\n'),
    );

    expect(errors).toEqual([]);
    expect(policies[0]?.conditions).toEqual([
      { arg: 'message.channel', match: 'general', negate: true },
    ]);
  });

  test('a rule without conditions is unchanged', () => {
    const { policies } = parseFrom(
      ['policies:', '  - match: "*"', '    action: always_run'].join('\n'),
    );

    expect(policies).toEqual([{ match: '*', action: 'always_run' }]);
  });

  test('malformed conditions are a hard error, never a silently dropped field', () => {
    // Dropping the field would turn "only these recipients" into "any
    // recipient" — the rule would look saved while protecting nothing.
    const { policies, errors } = parseFrom(
      [
        'policies:',
        '  - match: gmail.send_email',
        '    action: require_approval',
        '    conditions:',
        '      - arg: to',
        '        match: "/(/"',
      ].join('\n'),
    );

    expect(policies).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain('conditions');
  });

  test('rejects a prototype-chain arg path', () => {
    const { policies, errors } = parseFrom(
      [
        'policies:',
        '  - match: gmail.send_email',
        '    action: block',
        '    conditions:',
        '      - arg: __proto__',
        '        match: "*"',
      ].join('\n'),
    );

    expect(policies).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('workspacePoliciesToTomlEntries — conditions round-trip', () => {
  test('serializes conditions back out', () => {
    const specs: WorkspacePolicySpec[] = [
      {
        match: 'gmail.send_email',
        action: 'require_approval',
        conditions: [{ arg: 'to', match: '/^owner@example\\.com$/', negate: true }],
      },
    ];

    expect(workspacePoliciesToTomlEntries(specs)).toEqual([
      {
        match: 'gmail.send_email',
        action: 'require_approval',
        conditions: [{ arg: 'to', match: '/^owner@example\\.com$/', negate: true }],
      },
    ]);
  });

  test('omits the key entirely when there are no conditions', () => {
    expect(workspacePoliciesToTomlEntries([{ match: '*', action: 'block' }])).toEqual([
      { match: '*', action: 'block' },
    ]);
    expect(workspacePoliciesToTomlEntries([{ match: '*', action: 'block', conditions: [] }])).toEqual(
      [{ match: '*', action: 'block' }],
    );
  });

  test('survives a full parse → serialize → parse cycle', () => {
    const yaml = [
      'policies:',
      '  - match: gmail.send_email',
      '    action: require_approval',
      '    conditions:',
      '      - arg: to',
      '        match: /^owner@example\\.com$/',
    ].join('\n');

    const first = parseFrom(yaml);
    const reparsed = parseFrom(
      ['policies:', ...serializeEntries(workspacePoliciesToTomlEntries(first.policies))].join('\n'),
    );

    expect(reparsed.errors).toEqual([]);
    expect(reparsed.policies).toEqual(first.policies);
  });
});

/** Minimal YAML emitter for the round-trip test above. */
function serializeEntries(entries: Array<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`  - match: ${JSON.stringify(e.match)}`);
    lines.push(`    action: ${e.action}`);
    const conditions = e.conditions as
      | Array<{ arg: string; match: string; negate?: boolean }>
      | undefined;
    if (conditions) {
      lines.push('    conditions:');
      for (const c of conditions) {
        lines.push(`      - arg: ${c.arg}`);
        lines.push(`        match: ${JSON.stringify(c.match)}`);
        if (c.negate) lines.push('        negate: true');
      }
    }
  }
  return lines;
}
