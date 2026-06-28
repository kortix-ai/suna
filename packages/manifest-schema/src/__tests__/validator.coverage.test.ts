import { describe, expect, test } from 'bun:test';
import {
  validateManifest,
  formatIssues,
  ENV_NAME_RE,
  GRANTABLE_KORTIX_CLI_ACTIONS,
  type ManifestIssue,
} from '../index.ts';

function errorPaths(input: string | Record<string, unknown>): string[] {
  return validateManifest(input).issues.filter((i) => i.severity === 'error').map((i) => i.path);
}

function warningPaths(input: string | Record<string, unknown>): string[] {
  return validateManifest(input).issues.filter((i) => i.severity === 'warning').map((i) => i.path);
}

describe('validateManifest — object input', () => {
  test('accepts an already-parsed object without re-parsing TOML', () => {
    const result = validateManifest({ kortix_version: 1 });
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({ kortix_version: 1 });
  });

  test('object input echoes the same object back as parsed', () => {
    const obj = { kortix_version: 1, project: { name: 'x' } };
    const result = validateManifest(obj);
    expect(result.parsed).toBe(obj);
  });

  test('object input with bad version is rejected', () => {
    const result = validateManifest({ kortix_version: 0 });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.path)).toContain('kortix_version');
  });

  test('version above known max produces an unsupported error', () => {
    const result = validateManifest({ kortix_version: 99 });
    expect(result.issues.some((i) => i.message.includes('Unsupported schema version'))).toBe(true);
  });
});

describe('validateManifest — failed TOML parse with non-toml error path', () => {
  test('non-string non-object behaviour: a syntax error returns null parsed', () => {
    const result = validateManifest('key = ');
    expect(result.parsed).toBeNull();
    expect(result.valid).toBe(false);
  });
});

describe('validateManifest — [project]', () => {
  test('non-table project is rejected', () => {
    expect(errorPaths('kortix_version = 1\nproject = "oops"')).toContain('project');
  });

  test('non-string project.name is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[project]\nname = 5')).toContain('project.name');
  });

  test('non-string project.description is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[project]\ndescription = 5')).toContain('project.description');
  });

  test('a fully valid project passes', () => {
    expect(validateManifest('kortix_version = 1\n[project]\nname = "X"\ndescription = "Y"').valid).toBe(true);
  });
});

describe('validateManifest — [opencode]', () => {
  test('non-table opencode is rejected', () => {
    expect(errorPaths('kortix_version = 1\nopencode = 1')).toContain('opencode');
  });

  test('absolute config_dir is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[opencode]\nconfig_dir = "/etc/x"')).toContain('opencode.config_dir');
  });

  test('parent-escaping config_dir is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[opencode]\nconfig_dir = "../x"')).toContain('opencode.config_dir');
  });

  test('empty config_dir is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[opencode]\nconfig_dir = ""')).toContain('opencode.config_dir');
  });

  test('non-string config_dir is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[opencode]\nconfig_dir = 5')).toContain('opencode.config_dir');
  });

  test('a clean relative config_dir passes', () => {
    expect(validateManifest('kortix_version = 1\n[opencode]\nconfig_dir = ".kortix/opencode"').valid).toBe(true);
  });
});

describe('validateManifest — [env] non-string entry', () => {
  test('non-string entries are rejected', () => {
    expect(errorPaths('kortix_version = 1\n[env]\nrequired = [5]')).toContain('env.required[0]');
  });

  test('non-array optional is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[env]\noptional = "X"')).toContain('env.optional');
  });
});

describe('validateManifest — [[agents]]', () => {
  test('non-array agents is rejected', () => {
    expect(errorPaths('kortix_version = 1\nagents = "x"')).toContain('agents');
  });

  test('missing agent name is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[agents]]\n')).toContain('agents[0].name');
  });

  test('invalid agent name slug is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[agents]]\nname = "Bad Name"')).toContain('agents[0].name');
  });

  test('duplicate agent names are rejected', () => {
    const paths = errorPaths('kortix_version = 1\n[[agents]]\nname = "a"\n[[agents]]\nname = "a"');
    expect(paths).toContain('agents[1].name');
  });

  test('a valid single agent passes', () => {
    expect(validateManifest('kortix_version = 1\n[[agents]]\nname = "worker"').valid).toBe(true);
  });

  test('agent connectors accepts "all"', () => {
    expect(validateManifest('kortix_version = 1\n[[agents]]\nname = "w"\nconnectors = "all"').valid).toBe(true);
  });

  test('agent connectors accepts "none"', () => {
    expect(validateManifest('kortix_version = 1\n[[agents]]\nname = "w"\nconnectors = "none"').valid).toBe(true);
  });

  test('agent connectors rejects an arbitrary string', () => {
    expect(errorPaths('kortix_version = 1\n[[agents]]\nname = "w"\nconnectors = "some"')).toContain(
      'agents[0].connectors',
    );
  });

  test('agent connectors rejects an empty-string array entry', () => {
    expect(errorPaths('kortix_version = 1\n[[agents]]\nname = "w"\nconnectors = ["good", ""]')).toContain(
      'agents[0].connectors[1]',
    );
  });

  test('kortix_cli accepts a grantable action', () => {
    expect(
      validateManifest('kortix_version = 1\n[[agents]]\nname = "w"\nkortix_cli = ["project.read"]').valid,
    ).toBe(true);
  });

  test('kortix_cli accepts the wildcard star', () => {
    expect(validateManifest('kortix_version = 1\n[[agents]]\nname = "w"\nkortix_cli = ["*"]').valid).toBe(true);
  });

  test('kortix_cli rejects a non-grantable account-scoped action', () => {
    expect(errorPaths('kortix_version = 1\n[[agents]]\nname = "w"\nkortix_cli = ["billing.read"]')).toContain(
      'agents[0].kortix_cli[0]',
    );
  });
});

describe('validateManifest — [[channels]]', () => {
  test('non-array channels is rejected', () => {
    expect(errorPaths('kortix_version = 1\nchannels = 1')).toContain('channels');
  });

  test('missing platform is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[channels]]\n')).toContain('channels[0].platform');
  });

  test('duplicate platform is rejected', () => {
    const paths = errorPaths(
      'kortix_version = 1\n[[channels]]\nplatform = "slack"\n[[channels]]\nplatform = "slack"',
    );
    expect(paths).toContain('channels[1].platform');
  });

  // Coercible values (booleans, 0/1, yes/no/on/off) are accepted to match the
  // runtime's coerceBool; only genuinely non-coercible values are rejected.
  test('non-coercible enabled is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[channels]]\nplatform = "slack"\nenabled = "maybe"')).toContain(
      'channels[0].enabled',
    );
  });

  test('non-array events is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[channels]]\nplatform = "slack"\nevents = "x"')).toContain(
      'channels[0].events',
    );
  });

  test('non-string event entry is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[channels]]\nplatform = "slack"\nevents = [1]')).toContain(
      'channels[0].events[0]',
    );
  });

  test('a valid channel passes', () => {
    expect(
      validateManifest('kortix_version = 1\n[[channels]]\nplatform = "slack"\nenabled = true\nevents = ["message"]')
        .valid,
    ).toBe(true);
  });
});

describe('validateManifest — [[apps]]', () => {
  test('non-array apps is rejected', () => {
    expect(errorPaths('kortix_version = 1\napps = 1')).toContain('apps');
  });

  test('missing slug is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[apps]]\n')).toContain('apps[0].slug');
  });

  test('duplicate slug is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[apps]]\nslug = "s"\n[[apps]]\nslug = "s"')).toContain('apps[1].slug');
  });

  test('non-coercible enabled is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[apps]]\nslug = "s"\nenabled = "maybe"')).toContain('apps[0].enabled');
  });

  test('non-array domains is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[apps]]\nslug = "s"\ndomains = "x"')).toContain('apps[0].domains');
  });

  test('non-string domain entry is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[apps]]\nslug = "s"\ndomains = [1]')).toContain('apps[0].domains[0]');
  });

  test('valid git source passes', () => {
    expect(
      validateManifest('kortix_version = 1\n[[apps]]\nslug = "s"\n[apps.source]\ntype = "git"').valid,
    ).toBe(true);
  });

  test('non-table build is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[apps]]\nslug = "s"\nbuild = "x"')).toContain('apps[0].build');
  });

  test('non-table env is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[apps]]\nslug = "s"\nenv = "x"')).toContain('apps[0].env');
  });

  test('non-table source is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[apps]]\nslug = "s"\nsource = "x"')).toContain('apps[0].source');
  });
});

describe('validateManifest — [[connectors]] provider requirements', () => {
  test('pipedream requires app', () => {
    expect(errorPaths('kortix_version = 1\n[[connectors]]\nslug = "p"\nprovider = "pipedream"')).toContain(
      'connectors[0].app',
    );
  });

  test('graphql requires endpoint', () => {
    expect(errorPaths('kortix_version = 1\n[[connectors]]\nslug = "g"\nprovider = "graphql"')).toContain(
      'connectors[0].endpoint',
    );
  });

  test('http requires base_url', () => {
    expect(errorPaths('kortix_version = 1\n[[connectors]]\nslug = "h"\nprovider = "http"')).toContain(
      'connectors[0].base_url',
    );
  });

  test('non-table auth is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[connectors]]\nslug = "h"\nprovider = "http"\nbase_url = "x"\nauth = "y"')).toContain(
      'connectors[0].auth',
    );
  });

  test('unknown auth type is rejected', () => {
    expect(
      errorPaths(
        'kortix_version = 1\n[[connectors]]\nslug = "h"\nprovider = "http"\nbase_url = "x"\n[connectors.auth]\ntype = "oauth"',
      ),
    ).toContain('connectors[0].auth.type');
  });

  test('non-array policies is rejected', () => {
    expect(
      errorPaths(
        'kortix_version = 1\n[[connectors]]\nslug = "h"\nprovider = "http"\nbase_url = "x"\npolicies = "y"',
      ),
    ).toContain('connectors[0].policies');
  });

  test('policy missing match is rejected', () => {
    expect(
      errorPaths(
        'kortix_version = 1\n[[connectors]]\nslug = "h"\nprovider = "http"\nbase_url = "x"\n[[connectors.policies]]\naction = "always_run"',
      ),
    ).toContain('connectors[0].policies[0].match');
  });

  test('a valid http connector with bearer auth and a policy passes', () => {
    expect(
      validateManifest(
        'kortix_version = 1\n[[connectors]]\nslug = "h"\nprovider = "http"\nbase_url = "https://x"\n[connectors.auth]\ntype = "bearer"\n[[connectors.policies]]\nmatch = "*"\naction = "require_approval"',
      ).valid,
    ).toBe(true);
  });
});

describe('validateManifest — trigger edge cases', () => {
  test('run_at one-off cron without a cron expression is valid', () => {
    expect(
      validateManifest(
        'kortix_version = 1\n[[triggers]]\nslug = "once"\ntype = "cron"\nrun_at = "2026-06-01T09:00:00Z"\nprompt = "go"',
      ).valid,
    ).toBe(true);
  });

  test('invalid run_at datetime is rejected', () => {
    expect(
      errorPaths(
        'kortix_version = 1\n[[triggers]]\nslug = "once"\ntype = "cron"\nrun_at = "not-a-date"\nprompt = "go"',
      ),
    ).toContain('triggers[0].run_at');
  });

  test('non-string timezone is rejected', () => {
    expect(
      errorPaths(
        'kortix_version = 1\n[[triggers]]\nslug = "d"\ntype = "cron"\ncron = "0 0 * * *"\nprompt = "go"\ntimezone = 5',
      ),
    ).toContain('triggers[0].timezone');
  });

  test('non-boolean enabled is rejected', () => {
    expect(
      errorPaths(
        'kortix_version = 1\n[[triggers]]\nslug = "d"\ntype = "cron"\ncron = "0 0 * * *"\nprompt = "go"\nenabled = "x"',
      ),
    ).toContain('triggers[0].enabled');
  });

  test('unknown trigger type is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[[triggers]]\nslug = "d"\ntype = "queue"\nprompt = "x"')).toContain(
      'triggers[0].type',
    );
  });

  test('invalid webhook secret_env name is rejected', () => {
    expect(
      errorPaths(
        'kortix_version = 1\n[[triggers]]\nslug = "h"\ntype = "webhook"\nprompt = "x"\nsecret_env = "bad-name"',
      ),
    ).toContain('triggers[0].secret_env');
  });

  test('empty prompt is rejected', () => {
    expect(
      errorPaths('kortix_version = 1\n[[triggers]]\nslug = "d"\ntype = "cron"\ncron = "0 0 * * *"\nprompt = "   "'),
    ).toContain('triggers[0].prompt');
  });

  test('duplicate trigger slugs are rejected', () => {
    const paths = errorPaths(
      'kortix_version = 1\n[[triggers]]\nslug = "d"\ntype = "cron"\ncron = "0 0 * * *"\nprompt = "a"\n[[triggers]]\nslug = "d"\ntype = "cron"\ncron = "0 0 * * *"\nprompt = "b"',
    );
    expect(paths).toContain('triggers[1].slug');
  });
});

describe('validateManifest — sandbox bounds and types', () => {
  test('non-integer cpu is rejected', () => {
    expect(
      errorPaths('kortix_version = 1\n[[sandbox.templates]]\nslug = "x"\nimage = "u:1"\ncpu = 1.5'),
    ).toContain('sandbox.templates[0].cpu');
  });

  test('over-max memory produces a warning not an error', () => {
    const result = validateManifest('kortix_version = 1\n[[sandbox.templates]]\nslug = "x"\nimage = "u:1"\nmemory = 999');
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.path === 'sandbox.templates[0].memory' && i.severity === 'warning')).toBe(true);
  });

  test('digest-pinned image without a tag is accepted', () => {
    expect(
      validateManifest('kortix_version = 1\n[[sandbox.templates]]\nslug = "x"\nimage = "ubuntu@sha256:abc"').valid,
    ).toBe(true);
  });

  test('non-array templates is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[sandbox]\ntemplates = "x"')).toContain('sandbox.templates');
  });

  test('empty default slug is rejected', () => {
    expect(errorPaths('kortix_version = 1\n[sandbox]\ndefault = "  "')).toContain('sandbox.default');
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

  test('GRANTABLE_KORTIX_CLI_ACTIONS includes project and channel actions but not billing', () => {
    expect(GRANTABLE_KORTIX_CLI_ACTIONS).toContain('project.read');
    expect(GRANTABLE_KORTIX_CLI_ACTIONS).toContain('channel.send');
    expect(GRANTABLE_KORTIX_CLI_ACTIONS).not.toContain('billing.read');
  });
});

// Things the runtime rejects but that the gate surfaces as NON-BLOCKING warnings
// (no overblocking): the merge still passes (valid === true) while the author is
// told what would fail to materialize / deploy / fire at runtime.
describe('validateManifest — non-blocking warnings (runtime enforces; gate advises)', () => {
  function assertWarnsButValid(input: string, warnPath: string) {
    const result = validateManifest(input);
    expect(result.valid).toBe(true);
    expect(warningPaths(input)).toContain(warnPath);
  }

  test('app with no [apps.source] warns (would not deploy) but does not block', () => {
    assertWarnsButValid('kortix_version = 1\n[[apps]]\nslug = "site"', 'apps[0].source');
  });

  test('tar app source without url warns', () => {
    assertWarnsButValid('kortix_version = 1\n[[apps]]\nslug = "site"\n  [apps.source]\n  type = "tar"', 'apps[0].source.url');
  });

  test('app env with a non-string value warns', () => {
    expect(warningPaths('kortix_version = 1\n[[apps]]\nslug = "s"\n  [apps.source]\n  type = "git"\n  [apps.env]\n  PORT = 3000')).toContain('apps[0].env.PORT');
  });

  test('over-long sandbox template slug warns (runtime would drop it) but does not block', () => {
    const longSlug = 'a'.repeat(80);
    assertWarnsButValid(`kortix_version = 1\n[[sandbox.templates]]\nslug = "${longSlug}"\nimage = "python:3.12-slim"`, `sandbox.templates[0].slug`);
  });

  test('mcp connector with a bad transport warns but does not block', () => {
    assertWarnsButValid('kortix_version = 1\n[[connectors]]\nslug = "m"\nprovider = "mcp"\nurl = "https://e.com"\ntransport = "grpc"', 'connectors[0].transport');
  });

  test('openapi connector missing spec warns', () => {
    expect(warningPaths('kortix_version = 1\n[[connectors]]\nslug = "o"\nprovider = "openapi"')).toContain('connectors[0].spec');
  });

  test('connector with a bad credential mode warns', () => {
    expect(warningPaths('kortix_version = 1\n[[connectors]]\nslug = "h"\nprovider = "http"\nbase_url = "https://e.com"\ncredential = "team"')).toContain('connectors[0].credential');
  });

  test('trigger with a non-IANA timezone warns (would never fire) but does not block', () => {
    assertWarnsButValid('kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\ntimezone = "PST"', 'triggers[0].timezone');
  });
});
