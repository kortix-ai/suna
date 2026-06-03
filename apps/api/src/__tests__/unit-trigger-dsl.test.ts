import { describe, expect, test } from 'bun:test';
import {
  extractTriggers,
  parseManifestString,
  serializeManifest,
  KNOWN_SCHEMA_VERSION,
} from '../projects/triggers';

const MIN_PROJECT = `
[project]
name = "test"
`;

function manifestWith(triggersBlock: string): string {
  return [
    `kortix_version = ${KNOWN_SCHEMA_VERSION}`,
    MIN_PROJECT,
    triggersBlock,
  ].join('\n');
}

describe('kortix.toml — schema versioning', () => {
  test('missing kortix_version is rejected', () => {
    expect(() => parseManifestString(MIN_PROJECT)).toThrow(/kortix_version is required/);
  });

  test('explicit kortix_version = 1 round-trips', () => {
    const parsed = parseManifestString(`kortix_version = 1\n${MIN_PROJECT}`);
    expect(parsed.schemaVersion).toBe(1);
  });

  test('a future major version is rejected with a clear error', () => {
    expect(() => parseManifestString(`kortix_version = 99\n${MIN_PROJECT}`)).toThrow(/Unsupported kortix\.toml schema version 99/);
  });

  test('serialize always emits kortix_version as the first key', () => {
    const parsed = parseManifestString(`kortix_version = 1\n${MIN_PROJECT}`);
    const out = serializeManifest(parsed);
    expect(out.indexOf('kortix_version')).toBe(0);
  });
});

describe('[[triggers]] — happy paths', () => {
  test('parses a cron trigger end-to-end', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "daily-digest"
name = "Daily digest"
type = "cron"
agent = "default"
enabled = true
cron = "0 0 9 * * 1-5"
timezone = "UTC"
prompt = """
Pull the latest deploy logs and summarize regressions.
"""
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      slug: 'daily-digest',
      name: 'Daily digest',
      type: 'cron',
      agent: 'default',
      enabled: true,
      cron: '0 0 9 * * 1-5',
      timezone: 'UTC',
      secretEnv: null,
    });
    expect(specs[0]!.promptTemplate).toContain('Pull the latest deploy logs');
  });

  test('parses a one-off cron trigger with run_at (no cron)', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "launch-blast"
type = "cron"
run_at = "2099-01-01T09:00:00Z"
prompt = "Send the launch announcement."
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      slug: 'launch-blast',
      type: 'cron',
      cron: null,
      runAt: '2099-01-01T09:00:00.000Z',
      secretEnv: null,
    });
  });

  test('a one-off run_at round-trips through serialize (run_at, no cron)', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "once"
type = "cron"
run_at = "2099-01-01T09:00:00Z"
prompt = "x"
`));
    const out = serializeManifest(parsed);
    expect(out).toContain('run_at');
  });

  test('an invalid run_at is rejected with a clear error', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "bad-once"
type = "cron"
run_at = "not-a-date"
prompt = "x"
`));
    const { errors } = extractTriggers(parsed);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toMatch(/run_at must be an ISO-8601 datetime/);
  });

  test('a cron trigger with neither cron nor run_at is rejected', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "empty"
type = "cron"
prompt = "x"
`));
    const { errors } = extractTriggers(parsed);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toMatch(/expression or a one-off/);
  });

  test('parses a webhook trigger with secret_env reference', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "slack"
type = "webhook"
secret_env = "WEBHOOK_SLACK_SECRET"
prompt = "New {{ message.text }}"
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      slug: 'slack',
      type: 'webhook',
      agent: 'default',
      enabled: true,
      cron: null,
      timezone: 'UTC',
      secretEnv: 'WEBHOOK_SLACK_SECRET',
    });
    expect(specs[0]!.promptTemplate).toBe('New {{ message.text }}');
  });

  test('multiple triggers in one manifest — sorted A-Z by slug', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "zeta"
type = "cron"
cron = "* * * * * *"
prompt = "z"

[[triggers]]
slug = "alpha"
type = "cron"
cron = "* * * * * *"
prompt = "a"
`));
    const { specs } = extractTriggers(parsed);
    expect(specs.map((s) => s.slug)).toEqual(['alpha', 'zeta']);
  });

  test('defaults: name falls back to slug, enabled defaults to true', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "unnamed"
type = "cron"
cron = "* * * * * *"
prompt = "do the thing"
`));
    const { specs } = extractTriggers(parsed);
    expect(specs[0]!.name).toBe('unnamed');
    expect(specs[0]!.enabled).toBe(true);
  });

  test('schedule is not accepted as an alias for cron', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "aliased"
type = "cron"
schedule = "0 */5 * * * *"
prompt = "body"
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/cron triggers must declare/);
  });

  test('prompt_template is not accepted as an alias for prompt', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "old-shape"
type = "cron"
cron = "* * * * * *"
prompt_template = "legacy field name"
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/prompt is required/);
  });
});

describe('[[triggers]] — validation errors', () => {
  test('an empty manifest yields zero triggers, no errors', () => {
    const parsed = parseManifestString(`kortix_version = 1\n${MIN_PROJECT}`);
    expect(extractTriggers(parsed)).toEqual({ specs: [], errors: [] });
  });

  test('a [triggers] table (single brackets) is rejected with guidance', () => {
    const parsed = parseManifestString(`kortix_version = 1\n${MIN_PROJECT}\n[triggers]\nslug = "x"\n`);
    const { specs, errors } = extractTriggers(parsed);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/array of tables/);
  });

  test('rejects an invalid slug', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "Bad Slug"
type = "cron"
cron = "* * * * * *"
prompt = "x"
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/Invalid slug/);
  });

  test('rejects an unknown type', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "bad-type"
type = "scheduled"
prompt = "x"
`));
    const { errors } = extractTriggers(parsed);
    expect(errors[0]!.error).toMatch(/type must be/);
  });

  test('rejects an empty prompt', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "empty"
type = "cron"
cron = "* * * * * *"
prompt = ""
`));
    const { errors } = extractTriggers(parsed);
    expect(errors[0]!.error).toMatch(/prompt is required/);
  });

  test('rejects a cron trigger missing the cron expression', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "nocron"
type = "cron"
prompt = "x"
`));
    const { errors } = extractTriggers(parsed);
    expect(errors[0]!.error).toMatch(/cron triggers must declare/);
  });

  test('rejects camelCase runAt in favor of run_at', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "camel-once"
type = "cron"
runAt = "2099-01-01T09:00:00Z"
prompt = "x"
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/cron triggers must declare/);
  });

  test('rejects agent_name in favor of agent', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "agent-alias"
type = "cron"
cron = "* * * * * *"
agent_name = "reviewer"
prompt = "x"
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs[0]!.agent).toBe('default');
  });

  test('rejects a webhook trigger missing secret_env', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "opensecret"
type = "webhook"
prompt = "x"
`));
    const { errors } = extractTriggers(parsed);
    expect(errors[0]!.error).toMatch(/secret_env/);
  });

  test('rejects camelCase secretEnv in favor of secret_env', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "camel-secret"
type = "webhook"
secretEnv = "WEBHOOK_SECRET"
prompt = "x"
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/secret_env/);
  });

  test('rejects secret_env that does not look like an env var name', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "wronglysecret"
type = "webhook"
secret_env = "my-secret"
prompt = "x"
`));
    const { errors } = extractTriggers(parsed);
    expect(errors[0]!.error).toMatch(/project_secrets name/);
  });

  test('rejects duplicate slugs — first wins, second errors', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
slug = "dupe"
type = "cron"
cron = "* * * * * *"
prompt = "first"

[[triggers]]
slug = "dupe"
type = "cron"
cron = "* * * * * *"
prompt = "second"
`));
    const { specs, errors } = extractTriggers(parsed);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.promptTemplate).toBe('first');
    expect(errors[0]!.error).toMatch(/Duplicate trigger slug/);
  });

  test('an entry missing a slug surfaces an index-based error', () => {
    const parsed = parseManifestString(manifestWith(`
[[triggers]]
type = "cron"
cron = "* * * * * *"
prompt = "x"
`));
    const { errors } = extractTriggers(parsed);
    expect(errors[0]!.error).toMatch(/missing a slug/);
  });
});

describe('serializeManifest — round-trip', () => {
  test('a parsed-then-serialized manifest re-parses to the same shape', () => {
    const input = manifestWith(`
[[triggers]]
slug = "rt"
name = "Round-trip"
type = "cron"
agent = "default"
enabled = true
cron = "0 0 9 * * 1-5"
timezone = "UTC"
prompt = "Hello"
`);
    const parsed = parseManifestString(input);
    const serialized = serializeManifest(parsed);
    const reparsed = parseManifestString(serialized);
    const a = extractTriggers(parsed).specs;
    const b = extractTriggers(reparsed).specs;
    expect(b).toEqual(a);
  });
});
