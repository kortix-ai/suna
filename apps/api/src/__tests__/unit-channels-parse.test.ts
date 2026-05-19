import { describe, expect, test } from 'bun:test';
import { parseManifestString, KNOWN_SCHEMA_VERSION } from '../projects/triggers';
import { extractChannels, channelSpecToTomlEntry } from '../channels/manifest';

const MIN_PROJECT = `
[project]
name = "test"
`;

function manifestWith(block: string): string {
  return [`kortix_version = ${KNOWN_SCHEMA_VERSION}`, MIN_PROJECT, block].join('\n');
}

describe('[[channels]] — happy paths', () => {
  test('parses a slack mention channel end-to-end', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "eng"
name = "Engineering Slack"
platform = "slack"
channel_id = "C01234567"
enabled = true
agent = "kortix"
events = ["mention", "dm"]
response = "text"
prompt_prefix = "Hi {{ message.text }}"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      slug: 'eng',
      name: 'Engineering Slack',
      platform: 'slack',
      channelId: 'C01234567',
      channelName: null,
      enabled: true,
      agent: 'kortix',
      events: ['mention', 'dm'],
      responseStyle: 'text',
      slashCommands: [],
    });
  });

  test('defaults — name from slug, agent="default", events=["mention"], response="text"', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "foo"
platform = "slack"
channel_id = "C01234567"
prompt_prefix = "hi"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      slug: 'foo',
      name: 'foo',
      agent: 'default',
      enabled: true,
      events: ['mention'],
      responseStyle: 'text',
    });
  });

  test('parses [[channels.slash_commands]] nested array', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "eng"
platform = "slack"
channel_id = "C01234567"
events = ["slash"]
prompt_prefix = "x"

  [[channels.slash_commands]]
  name = "plan"
  prompt = "plan: {{ args }}"

  [[channels.slash_commands]]
  name = "review"
  prompt = "review: {{ args }}"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(errors).toEqual([]);
    expect(specs[0]!.slashCommands).toEqual([
      { name: 'plan', promptTemplate: 'plan: {{ args }}' },
      { name: 'review', promptTemplate: 'review: {{ args }}' },
    ]);
  });

  test('round-trips through channelSpecToTomlEntry', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "eng"
platform = "slack"
channel_id = "C01234567"
events = ["mention"]
prompt_prefix = "hi"
max_concurrent_sessions = 3
`));
    const { specs } = extractChannels(parsed);
    const out = channelSpecToTomlEntry(specs[0]!);
    expect(out).toMatchObject({
      slug: 'eng',
      platform: 'slack',
      channel_id: 'C01234567',
      events: ['mention'],
      max_concurrent_sessions: 3,
    });
    expect(out).not.toHaveProperty('channel_name');
  });
});

describe('[[channels]] — validation errors', () => {
  test('missing slug', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
platform = "slack"
channel_id = "C01234567"
prompt_prefix = "x"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/missing a slug/);
  });

  test('unsupported platform', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "x"
platform = "irc"
channel_id = "C01234567"
prompt_prefix = "x"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/Unsupported platform/);
  });

  test('missing both channel_id and channel_name', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "x"
platform = "slack"
prompt_prefix = "x"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/channel_id or channel_name is required/);
  });

  test('both channel_id and channel_name is an error', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "x"
platform = "slack"
channel_id = "C01234567"
channel_name = "#general"
prompt_prefix = "x"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/not both/);
  });

  test('malformed slack channel_id', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "x"
platform = "slack"
channel_id = "lowercase"
prompt_prefix = "x"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/does not look right/);
  });

  test('slash events declared but no slash_commands', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "x"
platform = "slack"
channel_id = "C01234567"
events = ["slash"]
prompt_prefix = "x"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/no \[\[channels\.slash_commands\]\] are declared/);
  });

  test('unknown event name', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "x"
platform = "slack"
channel_id = "C01234567"
events = ["mention", "explode"]
prompt_prefix = "x"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/Unknown event "explode"/);
  });

  test('duplicate channel slug', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "dup"
platform = "slack"
channel_id = "C0000001"
prompt_prefix = "a"

[[channels]]
slug = "dup"
platform = "slack"
channel_id = "C0000002"
prompt_prefix = "b"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(specs).toHaveLength(1);
    expect(errors[0]!.error).toMatch(/Duplicate channel slug/);
  });

  test('two channels pointing at the same slack id collide', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "a"
platform = "slack"
channel_id = "C01234567"
prompt_prefix = "a"

[[channels]]
slug = "b"
platform = "slack"
channel_id = "C01234567"
prompt_prefix = "b"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(specs).toHaveLength(1);
    expect(errors[0]!.error).toMatch(/same slack channel/);
  });

  test('channels is missing → empty specs, no error', () => {
    const parsed = parseManifestString(manifestWith(''));
    expect(extractChannels(parsed)).toEqual({ specs: [], errors: [] });
  });

  test('channels declared as [channels] (not array of tables)', () => {
    const parsed = parseManifestString(manifestWith(`
[channels]
slug = "x"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/array of tables/);
  });

  test('max_concurrent_sessions must be a positive integer', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
slug = "x"
platform = "slack"
channel_id = "C01234567"
prompt_prefix = "x"
max_concurrent_sessions = -1
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/positive integer/);
  });
});
