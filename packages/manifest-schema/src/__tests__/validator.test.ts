import { describe, expect, test } from 'bun:test';
import { validateManifest, formatIssues } from '../index.ts';

function summarize(input: string | Record<string, unknown>) {
  const result = validateManifest(input);
  const errorPaths = result.issues
    .filter((i) => i.severity === 'error')
    .map((i) => i.path);
  const warningPaths = result.issues
    .filter((i) => i.severity === 'warning')
    .map((i) => i.path);
  return { ...result, errorPaths, warningPaths };
}

describe('validateManifest — syntax', () => {
  test('catches a TOML syntax error and surfaces line info', () => {
    const result = validateManifest('this is not valid = toml [\n');
    expect(result.valid).toBe(false);
    expect(result.parsed).toBeNull();
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].path).toBe('<toml>');
    expect(result.issues[0].message).toContain('Syntax error');
  });

  test('empty TOML is invalid without kortix_version', () => {
    const result = validateManifest('');
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].path).toBe('kortix_version');
  });
});

describe('validateManifest — kortix_version', () => {
  test('rejects non-integer kortix_version', () => {
    const { errorPaths } = summarize(`kortix_version = "one"`);
    expect(errorPaths).toContain('kortix_version');
  });

  test('rejects string kortix_version', () => {
    const { errorPaths } = summarize(`kortix_version = "1"`);
    expect(errorPaths).toContain('kortix_version');
  });

  test('rejects decimal kortix_version', () => {
    const { errorPaths } = summarize('kortix_version = 1.5');
    expect(errorPaths).toContain('kortix_version');
  });

  test('rejects a version higher than known', () => {
    const { errorPaths } = summarize('kortix_version = 2');
    expect(errorPaths).toContain('kortix_version');
  });

  test('rejects when kortix_version is missing', () => {
    const { errorPaths } = summarize(`[project]\nname = "x"`);
    expect(errorPaths).toContain('kortix_version');
  });
});

describe('validateManifest — [env]', () => {
  test('rejects non-array env.required', () => {
    const { errorPaths, valid } = summarize(`kortix_version = 1\n[env]\nrequired = "ANTHROPIC_API_KEY"`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('env.required');
  });

  test('accepts lowercase env names (upper-cased by the runtime)', () => {
    const { valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = ["api_key"]`,
    );
    // The runtime canonicalizes to uppercase; we don't fail the build for casing.
    expect(valid).toBe(true);
  });

  test('rejects names that start with a digit', () => {
    const { errorPaths, valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = ["1API_KEY"]`,
    );
    expect(valid).toBe(false);
    expect(errorPaths.some((p) => p.startsWith('env.required'))).toBe(true);
  });

  test('rejects names with hyphens or punctuation', () => {
    const { errorPaths, valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = ["MY-KEY"]`,
    );
    expect(valid).toBe(false);
    expect(errorPaths.some((p) => p.startsWith('env.required'))).toBe(true);
  });

  test('warns on unknown [env] keys', () => {
    const { warningPaths, valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = ["ANTHROPIC_API_KEY"]\noptional = ["X"]\nmystery = "?"`,
    );
    expect(valid).toBe(true);
    expect(warningPaths).toContain('env.mystery');
  });
});

describe('validateManifest — [[sandbox.templates]]', () => {
  test('valid image-based template passes', () => {
    const { valid, issues } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "py"
name = "Python"
image = "python:3.12-slim"
cpu = 2
memory = 4
disk = 20
`);
    expect(valid).toBe(true);
    expect(issues.every((i) => i.severity !== 'error')).toBe(true);
  });

  test('rejects entries with both image AND dockerfile', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "bad"
image = "python:3.12-slim"
dockerfile = ".kortix/Dockerfile.x"
`);
    expect(errorPaths).toContain('sandbox.templates[0]');
  });

  test('rejects entries with neither image nor dockerfile', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "empty"
`);
    expect(errorPaths).toContain('sandbox.templates[0]');
  });

  test('rejects "default" as a reserved slug', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "default"
image = "ubuntu:22.04"
`);
    expect(errorPaths).toContain('sandbox.templates[0].slug');
  });

  test('rejects "latest" image tag with a warning (does not block)', () => {
    const { valid, warningPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "ml"
image = "python:latest"
`);
    expect(valid).toBe(true);
    expect(warningPaths).toContain('sandbox.templates[0].image');
  });

  test('rejects image without a tag or digest', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "x"
image = "ubuntu"
`);
    expect(errorPaths).toContain('sandbox.templates[0].image');
  });

  test('rejects bad slug format', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "Bad Slug!"
image = "ubuntu:22.04"
`);
    expect(errorPaths).toContain('sandbox.templates[0].slug');
  });

  test('rejects duplicate slugs', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "ml"
image = "python:3.12-slim"

[[sandbox.templates]]
slug = "ml"
image = "python:3.11-slim"
`);
    expect(errorPaths).toContain('sandbox.templates[1].slug');
  });

  test('rejects out-of-bounds cpu', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "tiny"
image = "alpine:3.20"
cpu = 0
`);
    expect(errorPaths).toContain('sandbox.templates[0].cpu');
  });

  test('rejects relative-path-escape Dockerfiles', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "esc"
dockerfile = "../etc/Dockerfile"
`);
    expect(errorPaths).toContain('sandbox.templates[0].dockerfile');
  });

  test('rejects legacy singular [sandbox] table', () => {
    const { errorPaths } = summarize(`
kortix_version = 1

[sandbox]
dockerfile = ".kortix/Dockerfile"
`);
    expect(errorPaths).toContain('sandbox');
  });

  test('accepts [sandbox] default pointing at a defined template', () => {
    const { valid } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "dev"
image = "ubuntu:24.04"
[sandbox]
default = "dev"
`);
    expect(valid).toBe(true);
  });

  test('accepts [sandbox] default = "default" (the platform image)', () => {
    const { valid } = summarize(`
kortix_version = 1
[sandbox]
default = "default"
`);
    expect(valid).toBe(true);
  });

  test('rejects [sandbox] default that names no defined template', () => {
    const { valid, errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "dev"
image = "ubuntu:24.04"
[sandbox]
default = "ghost"
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('sandbox.default');
  });

  test('rejects the renamed legacy [[sandboxes]] form with a migration error', () => {
    const { valid, errorPaths } = summarize(`
kortix_version = 1
[[sandboxes]]
slug = "ml"
image = "python:3.12-slim"
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('sandboxes');
  });

  test('warns on gpu key (not supported)', () => {
    const { warningPaths, valid } = summarize(`
kortix_version = 1

[[sandbox.templates]]
slug = "gpu"
image = "nvidia/cuda:12.2.0-base-ubuntu22.04"
gpu = 1
`);
    expect(valid).toBe(true);
    expect(warningPaths).toContain('sandbox.templates[0].gpu');
  });
});

describe('validateManifest — [[triggers]]', () => {
  test('cron trigger requires cron expression and prompt', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "no-cron"
type = "cron"
`);
    expect(errorPaths).toContain('triggers[0].cron');
    expect(errorPaths).toContain('triggers[0].prompt');
  });

  test('webhook trigger requires secret_env', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "hook"
type = "webhook"
prompt = "hi"
`);
    expect(errorPaths).toContain('triggers[0].secret_env');
  });

  test('valid cron trigger passes', () => {
    const { valid } = summarize(`
kortix_version = 1
[[triggers]]
slug = "daily"
type = "cron"
cron = "0 0 9 * * 1-5"
prompt = "Daily digest"
`);
    expect(valid).toBe(true);
  });
});

describe('validateManifest — [[connectors]]', () => {
  test('provider must be one of the known values', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "wat"
provider = "made-up"
`);
    expect(errorPaths).toContain('connectors[0].provider');
  });

  test('mcp connector requires url', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "mcp1"
provider = "mcp"
`);
    expect(errorPaths).toContain('connectors[0].url');
  });

  test('auth.secret is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "stripe"
provider = "openapi"
spec = "https://example.com/openapi.json"
  [connectors.auth]
  type = "bearer"
  secret = "STRIPE_API_KEY"
`);
    expect(errorPaths).toContain('connectors[0].auth.secret');
  });

  test('policy action must be one of the known values', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "stripe"
provider = "openapi"
spec = "https://example.com/openapi.json"
  [connectors.auth]
  type = "none"
  [[connectors.policies]]
  match = "*"
  action = "ALLOW"
`);
    expect(errorPaths).toContain('connectors[0].policies[0].action');
  });
});

describe('validateManifest — [[apps]]', () => {
  test('source.type must be git or tar', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[apps]]
slug = "site"
  [apps.source]
  type = "ftp"
`);
    expect(errorPaths).toContain('apps[0].source.type');
  });
});

describe('formatIssues', () => {
  test('renders both errors and warnings in a stable shape', () => {
    const { issues } = validateManifest(`
[[sandbox.templates]]
slug = "default"
image = "ubuntu:22.04"
`);
    const text = formatIssues(issues, { color: false });
    expect(text).toContain('error sandbox.templates[0].slug');
    expect(text).toContain('kortix_version');
  });
});
