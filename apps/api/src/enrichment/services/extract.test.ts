import { describe, expect, test } from 'bun:test';
import { EnrichmentError } from '../errors';
import { CompanyProfileSchema } from '../schemas';
import { extractProfile, formatIssues, parseJsonLoose, type ChatFn } from './extract';

const VALID_PROFILE = {
  name: 'Example Inc',
  tagline: 'We do things',
  description: 'Example Inc builds tools.',
  products: [{ name: 'Widget', description: 'A widget', url: 'https://example.com/widget' }],
  team: [{ name: 'Ada Lovelace', role: 'CEO', link: 'https://example.com/team/ada' }],
  socials: [{ platform: 'twitter', url: 'https://twitter.com/example' }],
  pricingSummary: 'Free tier plus paid plans.',
  blogPosts: [{ title: 'Launch', url: 'https://example.com/blog/launch', date: '2026-01-02' }],
  contact: { email: 'hi@example.com', phone: null, address: null },
  sectionSources: [{ section: 'team', urls: ['https://example.com/team'] }],
  sources: ['https://example.com/', 'https://example.com/team'],
};

function scriptedChat(responses: string[]): { chat: ChatFn; calls: number } {
  const state = { calls: 0 };
  const chat: ChatFn = async () => {
    const next = responses[state.calls] ?? responses[responses.length - 1];
    state.calls += 1;
    return next;
  };
  return {
    chat,
    get calls() {
      return state.calls;
    },
  };
}

function recordingChat(responses: string[]) {
  const seen: Array<{ role: string; content: string }[]> = [];
  let calls = 0;
  const chat: ChatFn = async ({ messages }) => {
    seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
    const next = responses[calls] ?? responses[responses.length - 1];
    calls += 1;
    return next;
  };
  return { chat, seen, get calls() { return calls; } };
}

const OPTS = { model: 'glm-5.2' };

describe('parseJsonLoose', () => {
  test('parses a bare object', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  test('parses through a json code fence', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('parses through an unlabelled code fence', () => {
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('recovers an object preceded by prose', () => {
    expect(parseJsonLoose('Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });

  test('throws on an empty response', () => {
    expect(() => parseJsonLoose('   ')).toThrow();
  });

  test('throws on unparseable text', () => {
    expect(() => parseJsonLoose('not json at all')).toThrow();
  });
});

describe('formatIssues', () => {
  test('renders each violation with its path', () => {
    const result = CompanyProfileSchema.safeParse({ ...VALID_PROFILE, sources: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const text = formatIssues(result.error);
    expect(text).toContain('sources');
  });

  test('labels root-level violations', () => {
    const result = CompanyProfileSchema.safeParse('not an object');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(formatIssues(result.error)).toContain('(root)');
  });
});

describe('extractProfile', () => {
  test('returns the profile on a first-attempt valid response', async () => {
    const scripted = scriptedChat([JSON.stringify(VALID_PROFILE)]);
    const result = await extractProfile('pages', { ...OPTS, chat: scripted.chat });
    expect(result.attempts).toBe(1);
    expect(result.profile.name).toBe('Example Inc');
    expect(scripted.calls).toBe(1);
  });

  test('applies schema defaults for omitted collections', async () => {
    const minimal = {
      name: 'Example Inc',
      tagline: null,
      description: null,
      pricingSummary: null,
      sources: ['https://example.com/'],
    };
    const result = await extractProfile('pages', {
      ...OPTS,
      chat: scriptedChat([JSON.stringify(minimal)]).chat,
    });
    expect(result.profile.products).toEqual([]);
    expect(result.profile.team).toEqual([]);
    expect(result.profile.contact).toEqual({ email: null, phone: null, address: null });
  });

  test('repairs a malformed json response', async () => {
    const scripted = scriptedChat(['definitely not json', JSON.stringify(VALID_PROFILE)]);
    const result = await extractProfile('pages', { ...OPTS, chat: scripted.chat });
    expect(result.attempts).toBe(2);
  });

  test('repairs a schema-invalid response', async () => {
    const invalid = JSON.stringify({ ...VALID_PROFILE, sources: [] });
    const scripted = scriptedChat([invalid, JSON.stringify(VALID_PROFILE)]);
    const result = await extractProfile('pages', { ...OPTS, chat: scripted.chat });
    expect(result.attempts).toBe(2);
    expect(result.profile.sources).toHaveLength(2);
  });

  test('feeds the validation errors back to the model', async () => {
    const invalid = JSON.stringify({ ...VALID_PROFILE, sources: [] });
    const recorder = recordingChat([invalid, JSON.stringify(VALID_PROFILE)]);
    await extractProfile('pages', { ...OPTS, chat: recorder.chat });

    const repairTurn = recorder.seen[1];
    const followUp = repairTurn[repairTurn.length - 1].content;
    expect(followUp).toContain('sources');
    expect(followUp).toContain('did not match the required schema');
  });

  test('tells the model not to invent values while repairing', async () => {
    const recorder = recordingChat([
      JSON.stringify({ ...VALID_PROFILE, sources: [] }),
      JSON.stringify(VALID_PROFILE),
    ]);
    await extractProfile('pages', { ...OPTS, chat: recorder.chat });
    const repairTurn = recorder.seen[1];
    expect(repairTurn[repairTurn.length - 1].content).toContain('Do not invent');
  });

  test('gives up after the repair budget and reports extraction_failed', async () => {
    const scripted = scriptedChat([JSON.stringify({ ...VALID_PROFILE, sources: [] })]);
    await expect(extractProfile('pages', { ...OPTS, chat: scripted.chat })).rejects.toThrow(
      EnrichmentError,
    );
    expect(scripted.calls).toBe(3);
  });

  test('carries the extraction_failed code', async () => {
    const scripted = scriptedChat(['nope']);
    try {
      await extractProfile('pages', { ...OPTS, chat: scripted.chat });
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(EnrichmentError);
      expect((err as EnrichmentError).code).toBe('extraction_failed');
    }
  });

  test('honours a custom repair budget', async () => {
    const scripted = scriptedChat(['nope']);
    await expect(
      extractProfile('pages', { ...OPTS, chat: scripted.chat, maxRepairs: 0 }),
    ).rejects.toThrow(EnrichmentError);
    expect(scripted.calls).toBe(1);
  });

  test('propagates transport failures instead of marking extraction failed', async () => {
    const chat: ChatFn = async () => {
      throw new Error('upstream 503');
    };
    await expect(extractProfile('pages', { ...OPTS, chat })).rejects.toThrow('upstream 503');
  });

  test('rejects a profile whose team members lack names', async () => {
    const bad = JSON.stringify({ ...VALID_PROFILE, team: [{ name: '', role: 'CEO', link: null }] });
    const scripted = scriptedChat([bad]);
    await expect(extractProfile('pages', { ...OPTS, chat: scripted.chat })).rejects.toThrow(
      EnrichmentError,
    );
  });

  test('drops an invalid contact email rather than failing the profile', async () => {
    const withBadEmail = JSON.stringify({
      ...VALID_PROFILE,
      contact: { email: 'not-an-email', phone: null, address: null },
    });
    const result = await extractProfile('pages', {
      ...OPTS,
      chat: scriptedChat([withBadEmail]).chat,
    });
    expect(result.profile.contact.email).toBeNull();
  });

  test('passes the json schema and model through to the transport', async () => {
    const received: Array<{ model: string; jsonSchema: Record<string, unknown> }> = [];
    const chat: ChatFn = async ({ model, jsonSchema }) => {
      received.push({ model, jsonSchema });
      return JSON.stringify(VALID_PROFILE);
    };
    await extractProfile('pages', { chat, model: 'some-model' });
    expect(received[0].model).toBe('some-model');
    expect(JSON.stringify(received[0].jsonSchema)).toContain('sources');
  });

  test('includes the supplied pages in the first user turn', async () => {
    const recorder = recordingChat([JSON.stringify(VALID_PROFILE)]);
    await extractProfile('THE-PAGE-TEXT', { ...OPTS, chat: recorder.chat });
    expect(recorder.seen[0].some((m) => m.content.includes('THE-PAGE-TEXT'))).toBe(true);
  });
});
