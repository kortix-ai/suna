import { describe, expect, test } from 'bun:test';
import {
  CRON_MIN_INTERVAL_SECONDS,
  DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR,
  cronIntervalError,
  validateManifest,
  formatIssues,
  ENV_NAME_RE,
  GRANTABLE_KORTIX_PERMISSIONS,
  type ManifestIssue,
} from '../index.ts';

/** One trigger `d` whose other fields are the YAML lines in `fields`. */
const trig = (fields: string) => `triggers:\n  - slug: d\n${fields.trim().split('\n').map((l) => `    ${l}`).join('\n')}\n`;

function errorPaths(input: string | Record<string, unknown>): string[] {
  return validateManifest(input).issues.filter((i) => i.severity === 'error').map((i) => i.path);
}

function warningPaths(input: string | Record<string, unknown>): string[] {
  return validateManifest(input).issues.filter((i) => i.severity === 'warning').map((i) => i.path);
}

describe('validateManifest — object input', () => {
  test('accepts an already-parsed object without re-parsing', () => {
    const result = validateManifest({});
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({});
  });

  test('object input echoes the same object back as parsed', () => {
    const obj = { project: { name: 'x' } };
    const result = validateManifest(obj);
    expect(result.parsed).toBe(obj);
  });

  test('object input with a retired version is rejected', () => {
    const result = validateManifest({ kortix_version: 99 });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.path)).toEqual(['kortix_version']);
  });
});

describe('validateManifest — failed parse', () => {
  test('a syntax error returns null parsed', () => {
    const result = validateManifest('key: [');
    expect(result.parsed).toBeNull();
    expect(result.valid).toBe(false);
  });
});

describe('validateManifest — project', () => {
  test('non-table project is rejected', () => {
    expect(errorPaths('project: oops\n')).toContain('project');
  });

  test('non-string project.name is rejected', () => {
    expect(errorPaths('project:\n  name: 5\n')).toContain('project.name');
  });

  test('non-string project.description is rejected', () => {
    expect(errorPaths('project:\n  description: 5\n')).toContain('project.description');
  });

  test('a fully valid project passes', () => {
    expect(validateManifest('project:\n  name: X\n  description: Y\n').valid).toBe(true);
  });
});

describe('validateManifest — env non-string entry', () => {
  test('non-string entries are rejected', () => {
    expect(errorPaths('env:\n  required:\n    - 5\n')).toContain('env.required[0]');
  });

  test('non-array optional is rejected', () => {
    expect(errorPaths('env:\n  optional: X\n')).toContain('env.optional');
  });
});

describe('validateManifest — agents', () => {
  const agent = (body = '') => `agents:\n  w:\n    prompt: go\n    tools: all\n${body}`;

  test('a non-map agents is rejected', () => {
    expect(errorPaths('agents: x\n')).toContain('agents');
  });

  test('an invalid agent name is rejected', () => {
    expect(errorPaths('agents:\n  Bad Name: {}\n')).toContain('agents.Bad Name');
  });

  test('a valid single agent passes', () => {
    expect(validateManifest(agent()).valid).toBe(true);
  });

  test('agent connectors accepts "all"', () => {
    expect(validateManifest(agent('    connectors: all\n')).valid).toBe(true);
  });

  test('agent connectors accepts "none"', () => {
    expect(validateManifest(agent('    connectors: none\n')).valid).toBe(true);
  });

  test('agent connectors rejects an arbitrary string', () => {
    expect(errorPaths(agent('    connectors: some\n'))).toContain('agents.w.connectors');
  });

  test('agent connectors rejects an empty-string array entry', () => {
    expect(errorPaths(agent('    connectors:\n      - good\n      - ""\n'))).toContain('agents.w.connectors[1]');
  });

  test('kortix_permissions accepts a grantable action', () => {
    expect(validateManifest(agent('    kortix_permissions:\n      - project.read\n')).valid).toBe(true);
  });

  test('kortix_permissions accepts the wildcard star', () => {
    expect(validateManifest(agent('    kortix_permissions:\n      - "*"\n')).valid).toBe(true);
  });

  test('kortix_permissions rejects a non-grantable account-scoped action', () => {
    expect(errorPaths(agent('    kortix_permissions:\n      - billing.read\n'))).toContain('agents.w.kortix_permissions[0]');
  });

  test('secrets accepts "all", "none", "" and an allowlist', () => {
    for (const value of ['all', 'none', '""', '[STRIPE_KEY, DB_URL]']) {
      expect(validateManifest(agent(`    secrets: ${value}\n`)).valid).toBe(true);
    }
  });

  test('secrets rejects a number, a table, an arbitrary string and bad list entries', () => {
    for (const [value, path] of [
      ['5', 'agents.w.secrets'],
      ['{ foo: bar }', 'agents.w.secrets'],
      ['some', 'agents.w.secrets'],
      ['[GOOD, 5]', 'agents.w.secrets[1]'],
      ['[GOOD, ""]', 'agents.w.secrets[1]'],
    ] as const) {
      expect(errorPaths(agent(`    secrets: ${value}\n`))).toContain(path);
    }
  });
});

describe('validateManifest — connectors provider requirements', () => {
  test('pipedream requires app', () => {
    expect(errorPaths('connectors:\n  - slug: p\n    provider: pipedream\n')).toContain(
      'connectors[0].app',
    );
  });

  test('graphql requires endpoint', () => {
    expect(errorPaths('connectors:\n  - slug: g\n    provider: graphql\n')).toContain(
      'connectors[0].endpoint',
    );
  });

  test('http requires base_url', () => {
    expect(errorPaths('connectors:\n  - slug: h\n    provider: http\n')).toContain(
      'connectors[0].base_url',
    );
  });

  test('non-table auth is rejected', () => {
    expect(errorPaths('connectors:\n  - slug: h\n    provider: http\n    base_url: x\n    auth: y\n')).toContain(
      'connectors[0].auth',
    );
  });

  test('unknown auth type is rejected', () => {
    expect(
      errorPaths(
        'connectors:\n  - slug: h\n    provider: http\n    base_url: x\n    auth:\n      type: oauth\n',
      ),
    ).toContain('connectors[0].auth.type');
  });

  test('non-array policies is rejected', () => {
    expect(
      errorPaths(
        'connectors:\n  - slug: h\n    provider: http\n    base_url: x\n    policies: y\n',
      ),
    ).toContain('connectors[0].policies');
  });

  test('policy missing match is rejected', () => {
    expect(
      errorPaths(
        'connectors:\n  - slug: h\n    provider: http\n    base_url: x\n    policies:\n      - action: always_run\n',
      ),
    ).toContain('connectors[0].policies[0].match');
  });

  test('a valid http connector with bearer auth and a policy passes', () => {
    expect(
      validateManifest(
        'connectors:\n  - slug: h\n    provider: http\n    base_url: https://x\n    auth:\n      type: bearer\n    policies:\n      - match: "*"\n        action: require_approval\n',
      ).valid,
    ).toBe(true);
  });
});

describe('validateManifest — trigger edge cases', () => {
  test('run_at one-off cron without a cron expression is valid', () => {
    expect(
      validateManifest(
        'triggers:\n  - slug: once\n    type: cron\n    run_at: 2026-06-01T09:00:00Z\n    prompt: go\n',
      ).valid,
    ).toBe(true);
  });

  test('invalid run_at datetime is rejected', () => {
    expect(
      errorPaths(
        'triggers:\n  - slug: once\n    type: cron\n    run_at: not-a-date\n    prompt: go\n',
      ),
    ).toContain('triggers[0].run_at');
  });

  test('non-string timezone is rejected', () => {
    expect(
      errorPaths(
        'triggers:\n  - slug: d\n    type: cron\n    cron: 0 0 * * *\n    prompt: go\n    timezone: 5\n',
      ),
    ).toContain('triggers[0].timezone');
  });

  test('ambiguous timezone abbreviations are rejected', () => {
    expect(
      errorPaths(
        'triggers:\n  - slug: d\n    type: cron\n    cron: 0 9 * * *\n    prompt: go\n    timezone: PST\n',
      ),
    ).toContain('triggers[0].timezone');
  });

  test('invalid cron expressions are rejected', () => {
    expect(
      errorPaths(
        'triggers:\n  - slug: d\n    type: cron\n    cron: 0 25 * * *\n    prompt: go\n    timezone: UTC\n',
      ),
    ).toContain('triggers[0].cron');
  });

  // KRTX-1721: croner reads 6 fields as seconds-first, so `*/30 * * * * *` is
  // every 30 SECONDS. Each fire starts or prompts a session.
  test('a cron that fires more than once a minute is rejected and names the 60-second minimum', () => {
    for (const cron of ['*/30 * * * * *', '*/5 * * * * *', '0,30 * * * * *', '0,1 0 * * * *']) {
      const issue = validateManifest(
        trig(`type: cron\ncron: "${cron}"\nprompt: go`),
      ).issues.find((i) => i.path === 'triggers[0].cron' && i.severity === 'error');
      expect(issue?.message).toContain('60 seconds');
    }
  });

  test('a cron at most once a minute passes the floor', () => {
    for (const cron of ['0 */30 * * * *', '*/30 * * * *', '0 * * * * *', '* * * * *', '0 9 * * 1-5']) {
      expect(
        errorPaths(trig(`type: cron\ncron: "${cron}"\nprompt: go`)),
      ).not.toContain('triggers[0].cron');
    }
  });

  test('cronIntervalError is null at the floor and names the minimum below it', () => {
    expect(CRON_MIN_INTERVAL_SECONDS).toBe(60);
    expect(cronIntervalError('0 * * * * *')).toBeNull();
    expect(cronIntervalError('*/59 * * * * *')).toContain('60 seconds');
  });

  // KRTX-1721: a trigger starts at most `max_runs_per_hour` runs in any 60
  // minutes (60 when unset) and at most `max_runs_per_day` in a UTC day.
  const capTriggers = {
    cron: 'type: cron\ncron: 0 * * * *\n',
    webhook: 'type: webhook\n',
  };
  test('max_runs_per_hour and max_runs_per_day take a positive integer on any trigger type', () => {
    expect(DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR).toBe(60);
    for (const body of Object.values(capTriggers)) {
      const paths = errorPaths(
        trig(`${body}\nprompt: go\nmax_runs_per_hour: 2\nmax_runs_per_day: 3`),
      );
      expect(paths).not.toContain('triggers[0].max_runs_per_hour');
      expect(paths).not.toContain('triggers[0].max_runs_per_day');
    }
  });

  test('a run cap that is not a positive integer is rejected, naming the field', () => {
    for (const field of ['max_runs_per_hour', 'max_runs_per_day']) {
      for (const value of ['0', '-1', '1.5', '"10"']) {
        const issue = validateManifest(
          trig(`${capTriggers.cron}\nprompt: go\n${field}: ${value}`),
        ).issues.find((i) => i.path === `triggers[0].${field}` && i.severity === 'error');
        expect({ field, value, message: issue?.message }).toEqual({ field, value, message: `${field} must be a whole number of at least 1.` });
      }
    }
  });

  // KRTX-1721: `overlap` is skip or allow, on any trigger type.
  test('overlap takes skip or allow; anything else is rejected, naming the field', () => {
    for (const value of ['"skip"', '"allow"']) {
      const paths = errorPaths(trig(`${capTriggers.cron}\nprompt: go\noverlap: ${value}`));
      expect(paths).not.toContain('triggers[0].overlap');
    }
    for (const value of ['"queue"', 'true', '1']) {
      const issue = validateManifest(
        trig(`${capTriggers.cron}\nprompt: go\noverlap: ${value}`),
      ).issues.find((i) => i.path === 'triggers[0].overlap' && i.severity === 'error');
      expect({ value, message: issue?.message }).toEqual({ value, message: 'overlap must be "skip" or "allow".' });
    }
  });

  // KRTX-1721: `filter` takes a value (equals) or one operator per path.
  test('a filter with equality and every operator is accepted', () => {
    const paths = errorPaths(
      trig(
        `${capTriggers.webhook}\nprompt: go\nfilter: { body.type: push, body.sender.login: { not: kortix-bot }, body.action: { in: [opened, reopened] }, ` +
          'body.pull_request: { exists: true }, body.ref: { not_prefix: "refs/heads/kortix/" }, body.base: { prefix: ["release/"] } }',
      ),
    );
    expect(paths.filter((p) => p.startsWith('triggers[0].filter'))).toEqual([]);
  });

  test('a filter with an unknown operator is rejected with the parser message', () => {
    const issue = validateManifest(
      trig(`${capTriggers.webhook}\nprompt: go\nfilter: { body.ref: { nott: x } }`),
    ).issues.find((i) => i.path === 'triggers[0].filter' && i.severity === 'error');
    expect(issue?.message).toBe('filter.body.ref has an unknown operator "nott"; use one of: not, in, exists, prefix, not_prefix.');
  });

  test('non-boolean enabled is rejected', () => {
    expect(
      errorPaths(
        'triggers:\n  - slug: d\n    type: cron\n    cron: 0 0 * * *\n    prompt: go\n    enabled: x\n',
      ),
    ).toContain('triggers[0].enabled');
  });

  test('unknown trigger type is rejected', () => {
    expect(errorPaths('triggers:\n  - slug: d\n    type: queue\n    prompt: x\n')).toContain(
      'triggers[0].type',
    );
  });

  test('invalid webhook secret_env name is rejected', () => {
    expect(
      errorPaths(
        'triggers:\n  - slug: h\n    type: webhook\n    prompt: x\n    secret_env: bad-name\n',
      ),
    ).toContain('triggers[0].secret_env');
  });

  test('empty prompt is rejected', () => {
    expect(
      errorPaths('triggers:\n  - slug: d\n    type: cron\n    cron: 0 0 * * *\n    prompt: "   "\n'),
    ).toContain('triggers[0].prompt');
  });

  test('duplicate trigger slugs are rejected', () => {
    const paths = errorPaths(
      'triggers:\n  - slug: d\n    type: cron\n    cron: 0 0 * * *\n    prompt: a\n  - slug: d\n    type: cron\n    cron: 0 0 * * *\n    prompt: b\n',
    );
    expect(paths).toContain('triggers[1].slug');
  });
});

describe('validateManifest — sandbox bounds and types', () => {
  test('non-integer cpu is rejected', () => {
    expect(
      errorPaths('sandbox:\n  templates:\n    - slug: x\n      image: u:1\n      cpu: 1.5\n'),
    ).toContain('sandbox.templates[0].cpu');
  });

  test('over-max memory produces a warning not an error', () => {
    const result = validateManifest('sandbox:\n  templates:\n    - slug: x\n      image: u:1\n      memory: 999\n');
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.path === 'sandbox.templates[0].memory' && i.severity === 'warning')).toBe(true);
  });

  test('digest-pinned image without a tag is accepted', () => {
    expect(
      validateManifest('sandbox:\n  templates:\n    - slug: x\n      image: ubuntu@sha256:abc\n').valid,
    ).toBe(true);
  });

  test('non-array templates is rejected', () => {
    expect(errorPaths('sandbox:\n  templates: x\n')).toContain('sandbox.templates');
  });

  test('empty default slug is rejected', () => {
    expect(errorPaths('sandbox:\n  default: "  "\n')).toContain('sandbox.default');
  });
});

describe('formatIssues', () => {
  test('returns empty string for no issues', () => {
    expect(formatIssues([])).toBe('');
  });

  test('omits ANSI codes when color is false', () => {
    const issues: ManifestIssue[] = [{ path: 'x', message: 'boom', severity: 'error' }];
    const text = formatIssues(issues, { color: false });
    expect(text).not.toContain('\x1b[');
    expect(text).toContain('error x: boom');
  });

  test('includes ANSI codes by default', () => {
    const issues: ManifestIssue[] = [{ path: 'x', message: 'boom', severity: 'error' }];
    expect(formatIssues(issues)).toContain('\x1b[31m');
  });

  test('renders line and column when present', () => {
    const issues: ManifestIssue[] = [{ path: 'x', message: 'm', severity: 'error', line: 4, column: 7 }];
    expect(formatIssues(issues, { color: false })).toContain('(line 4:7)');
  });

  test('renders only the line when column is absent', () => {
    const issues: ManifestIssue[] = [{ path: 'x', message: 'm', severity: 'warning', line: 9 }];
    const text = formatIssues(issues, { color: false });
    expect(text).toContain('(line 9)');
    expect(text).not.toContain('(line 9:');
  });

  test('uses the warning tag for warnings', () => {
    const issues: ManifestIssue[] = [{ path: 'x', message: 'm', severity: 'warning' }];
    expect(formatIssues(issues, { color: false })).toContain('warning x: m');
  });
});

describe('exported constants', () => {
  test('ENV_NAME_RE matches a canonical env name', () => {
    expect(ENV_NAME_RE.test('ANTHROPIC_API_KEY')).toBe(true);
  });

  test('ENV_NAME_RE rejects names starting with a digit', () => {
    expect(ENV_NAME_RE.test('1KEY')).toBe(false);
  });

  test('ENV_NAME_RE rejects lowercase names', () => {
    expect(ENV_NAME_RE.test('lower')).toBe(false);
  });

  test('GRANTABLE_KORTIX_PERMISSIONS includes project actions but not billing or channel.*', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS).toContain('project.read');
    expect(GRANTABLE_KORTIX_PERMISSIONS).toContain('project.connector.write');
    expect(GRANTABLE_KORTIX_PERMISSIONS).toContain('project.usage.read');
    expect(GRANTABLE_KORTIX_PERMISSIONS).not.toContain('billing.read');
    // channel.* was removed from the catalog — never wired to any route.
    expect(GRANTABLE_KORTIX_PERMISSIONS).not.toContain('channel.send');
  });
});

// Things the runtime rejects but that the gate surfaces as NON-BLOCKING warnings
// (no overblocking): the merge still passes (valid === true) while the author is
// told what would fail to materialize or fire at runtime.
describe('validateManifest — non-blocking warnings (runtime enforces; gate advises)', () => {
  function assertWarnsButValid(input: string, warnPath: string) {
    const result = validateManifest(input);
    expect(result.valid).toBe(true);
    expect(warningPaths(input)).toContain(warnPath);
  }

  test('over-long sandbox template slug warns (runtime would drop it) but does not block', () => {
    const longSlug = 'a'.repeat(80);
    assertWarnsButValid(`sandbox:\n  templates:\n    - slug: ${longSlug}\n      image: python:3.12-slim\n`, `sandbox.templates[0].slug`);
  });

  test('mcp connector with a bad transport warns but does not block', () => {
    assertWarnsButValid('connectors:\n  - slug: m\n    provider: mcp\n    url: https://e.com\n    transport: grpc\n', 'connectors[0].transport');
  });

  test('openapi connector missing spec warns', () => {
    expect(warningPaths('connectors:\n  - slug: o\n    provider: openapi\n')).toContain('connectors[0].spec');
  });

  test('connector with a bad credential mode is an error', () => {
    expect(errorPaths('connectors:\n  - slug: h\n    provider: http\n    base_url: https://e.com\n    credential: team\n')).toContain('connectors[0].credential');
  });

});
