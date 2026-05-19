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
  test('platform alone is enough', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
platform = "slack"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      platform: 'slack',
      enabled: true,
      agent: null,
      promptPrefix: null,
      events: ['mention', 'dm'],
    });
  });

  test('full optional surface', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
platform = "slack"
enabled = false
agent = "kortix"
events = ["mention"]
prompt_prefix = "Hi {{ message.text }}"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      platform: 'slack',
      enabled: false,
      agent: 'kortix',
      promptPrefix: 'Hi {{ message.text }}',
      events: ['mention'],
    });
  });

  test('round-trip through channelSpecToTomlEntry omits defaults', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
platform = "slack"
`));
    const { specs } = extractChannels(parsed);
    const out = channelSpecToTomlEntry(specs[0]!);
    expect(out).toEqual({ platform: 'slack' });
  });

  test('round-trip keeps explicit non-default fields', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
platform = "slack"
agent = "kortix"
events = ["mention"]
prompt_prefix = "x"
`));
    const { specs } = extractChannels(parsed);
    const out = channelSpecToTomlEntry(specs[0]!);
    expect(out).toMatchObject({
      platform: 'slack',
      agent: 'kortix',
      events: ['mention'],
      prompt_prefix: 'x',
    });
  });
});

describe('[[channels]] — validation errors', () => {
  test('missing platform', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
agent = "kortix"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/Unsupported platform/);
  });

  test('unsupported platform', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
platform = "irc"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/Unsupported platform/);
  });

  test('unknown event name', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
platform = "slack"
events = ["mention", "explode"]
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/Unknown event "explode"/);
  });

  test('duplicate platform entries collide', () => {
    const parsed = parseManifestString(manifestWith(`
[[channels]]
platform = "slack"

[[channels]]
platform = "slack"
`));
    const { specs, errors } = extractChannels(parsed);
    expect(specs).toHaveLength(1);
    expect(errors[0]!.error).toMatch(/Duplicate \[\[channels\]\] entry for platform "slack"/);
  });

  test('channels missing entirely → no specs, no error', () => {
    const parsed = parseManifestString(manifestWith(''));
    expect(extractChannels(parsed)).toEqual({ specs: [], errors: [] });
  });

  test('[channels] (not array of tables) is rejected', () => {
    const parsed = parseManifestString(manifestWith(`
[channels]
platform = "slack"
`));
    const { errors } = extractChannels(parsed);
    expect(errors[0]!.error).toMatch(/array of tables/);
  });
});
