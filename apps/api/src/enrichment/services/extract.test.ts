import { describe, expect, test } from 'bun:test';
import { EnrichmentError } from '../errors';
import { CompanyProfileSchema, type CompanyProfile } from '../schemas';
import type { ConsolidatePage } from './consolidate';
import type { StructuredSignals } from './discovery';
import {
  buildReduceInput,
  extractProfile,
  extractProfileFromPages,
  formatIssues,
  mergeHarvestedSignals,
  parseJsonLoose,
  type ChatFn,
} from './extract';
import type { MapPagesResult } from './page-summary';

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

function emptySignals(overrides: Partial<StructuredSignals> = {}): StructuredSignals {
  return {
    title: null,
    jsonLd: [],
    openGraph: {},
    meta: {},
    socials: [],
    emails: [],
    phones: [],
    otherExternal: [],
    ...overrides,
  };
}

function page(url: string, markdown: string): ConsolidatePage {
  return { url, markdown, tier: 'priority' };
}

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

describe('mergeHarvestedSignals', () => {
  function profileWith(overrides: Partial<CompanyProfile>): CompanyProfile {
    return CompanyProfileSchema.parse({ ...VALID_PROFILE, ...overrides });
  }

  test('adds a harvested social the model did not return', () => {
    const profile = profileWith({ socials: [] });
    const merged = mergeHarvestedSignals(
      profile,
      emptySignals({ socials: [{ platform: 'github', url: 'https://github.com/example' }] }),
    );
    expect(merged.socials).toEqual([{ platform: 'github', url: 'https://github.com/example' }]);
  });

  test('does not duplicate a harvested social already returned by the model', () => {
    const profile = profileWith({
      socials: [{ platform: 'twitter', url: 'https://twitter.com/example' }],
    });
    const merged = mergeHarvestedSignals(
      profile,
      emptySignals({ socials: [{ platform: 'twitter', url: 'https://twitter.com/Example' }] }),
    );
    expect(merged.socials).toHaveLength(1);
  });

  test('never drops a model social absent from the harvest', () => {
    const profile = profileWith({
      socials: [{ platform: 'twitter', url: 'https://twitter.com/example' }],
    });
    const merged = mergeHarvestedSignals(profile, emptySignals());
    expect(merged.socials).toEqual([{ platform: 'twitter', url: 'https://twitter.com/example' }]);
  });

  test('fills contact.email from the harvest when the model left it null', () => {
    const profile = profileWith({ contact: { email: null, phone: null, address: null } });
    const merged = mergeHarvestedSignals(profile, emptySignals({ emails: ['hi@example.com'] }));
    expect(merged.contact.email).toBe('hi@example.com');
  });

  test('keeps the model contact email over the harvest', () => {
    const profile = profileWith({ contact: { email: 'model@example.com', phone: null, address: null } });
    const merged = mergeHarvestedSignals(profile, emptySignals({ emails: ['harvested@example.com'] }));
    expect(merged.contact.email).toBe('model@example.com');
  });

  test('drops a malformed harvested social rather than throwing', () => {
    const profile = profileWith({ socials: [] });
    const merged = mergeHarvestedSignals(
      profile,
      emptySignals({ socials: [{ platform: 'x', url: 'not-a-url' }] }),
    );
    expect(merged.socials).toEqual([]);
  });

  test('dedupes a harvested social matching a model social except for trailing slash', () => {
    const profile = profileWith({
      socials: [{ platform: 'twitter', url: 'https://twitter.com/example/' }],
    });
    const merged = mergeHarvestedSignals(
      profile,
      emptySignals({ socials: [{ platform: 'twitter', url: 'https://twitter.com/example' }] }),
    );
    expect(merged.socials).toHaveLength(1);
  });

  test('dedupes a harvested social matching except for case', () => {
    const profile = profileWith({
      socials: [{ platform: 'twitter', url: 'https://twitter.com/example' }],
    });
    const merged = mergeHarvestedSignals(
      profile,
      emptySignals({ socials: [{ platform: 'twitter', url: 'https://twitter.com/EXAMPLE' }] }),
    );
    expect(merged.socials).toHaveLength(1);
  });
});

describe('buildReduceInput', () => {
  function summaryMapResult(): MapPagesResult {
    return {
      mapped: [
        {
          url: 'https://example.com/about',
          kind: 'summary',
          summary: {
            url: 'https://example.com/about',
            pageKind: 'about',
            purpose: 'Introduces the company.',
            keyPoints: ['Founded in 2010'],
            entities: ['Example Inc'],
            pricingTiers: [],
            quotes: [],
          },
        },
        {
          url: 'https://example.com/contact',
          kind: 'excerpt',
          markdown: 'Call us at 555-0100.',
          degraded: false,
        },
      ],
      summarizedCount: 1,
      failedCount: 0,
    };
  }

  test('renders the trusted signals header', () => {
    const result = buildReduceInput(
      'example.com',
      emptySignals({ jsonLd: [{ '@type': 'Organization', name: 'Example Inc' }] }),
      summaryMapResult(),
    );
    expect(result.text).toContain('TRUSTED structured data');
  });

  test('renders a summarized page with its structured fields', () => {
    const result = buildReduceInput('example.com', emptySignals(), summaryMapResult());
    expect(result.text).toContain('Founded in 2010');
    expect(result.includedUrls).toContain('https://example.com/about');
  });

  test('renders an excerpt page as raw text', () => {
    const result = buildReduceInput('example.com', emptySignals(), summaryMapResult());
    expect(result.text).toContain('Call us at 555-0100.');
  });

  test('omits pages once the token budget is spent and records them', () => {
    const result = buildReduceInput('example.com', emptySignals(), summaryMapResult(), 1);
    expect(result.omittedUrls.length).toBeGreaterThan(0);
    expect(result.text).toContain('were not included');
  });
});

describe('extractProfileFromPages', () => {
  const DOMAIN = 'example.com';

  test('skips the map call for a short page and still produces a profile', async () => {
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      return JSON.stringify(VALID_PROFILE);
    };
    const result = await extractProfileFromPages(
      DOMAIN,
      [page('https://example.com/about', 'A short about page.')],
      emptySignals(),
      { chat, model: 'glm-5.2' },
    );
    expect(calls).toBe(1);
    expect(result.profile.name).toBe('Example Inc');
    expect(result.summarizedPages).toBe(0);
  });

  test('summarizes each long page exactly once', async () => {
    const long = `# About\n\n${'a'.repeat(5_000)}`;
    let mapCalls = 0;
    const chat: ChatFn = async ({ messages }) => {
      if (messages[0].content.includes('You summarize a single page')) {
        mapCalls += 1;
        return JSON.stringify({
          pageKind: 'about',
          purpose: 'A long about page.',
          keyPoints: [],
          entities: [],
          pricingTiers: [],
          quotes: [],
        });
      }
      return JSON.stringify(VALID_PROFILE);
    };
    const result = await extractProfileFromPages(
      DOMAIN,
      [page('https://example.com/a', long), page('https://example.com/b', long)],
      emptySignals(),
      { chat, model: 'glm-5.2' },
    );
    expect(mapCalls).toBe(2);
    expect(result.summarizedPages).toBe(2);
  });

  test('feeds the reduce pass the page summaries rather than the raw text', async () => {
    const long = `# About\n\nRAW-MARKER-ONLY-IN-SOURCE ${'a'.repeat(5_000)}`;
    let reduceUserContent = '';
    const chat: ChatFn = async ({ messages }) => {
      if (messages[0].content.includes('You summarize a single page')) {
        return JSON.stringify({
          pageKind: 'about',
          purpose: 'Distinctive summarized purpose text.',
          keyPoints: [],
          entities: [],
          pricingTiers: [],
          quotes: [],
        });
      }
      reduceUserContent = messages[messages.length - 1].content;
      return JSON.stringify(VALID_PROFILE);
    };
    await extractProfileFromPages(
      DOMAIN,
      [page('https://example.com/about', long)],
      emptySignals(),
      { chat, model: 'glm-5.2' },
    );
    expect(reduceUserContent).toContain('Distinctive summarized purpose text.');
    expect(reduceUserContent).not.toContain('RAW-MARKER-ONLY-IN-SOURCE');
  });

  test('degrades a failed map call to an excerpt and still produces a profile', async () => {
    const long = `# About\n\nDISTINCTIVE-RAW-TEXT ${'a'.repeat(5_000)}`;
    const chat: ChatFn = async ({ messages }) => {
      if (messages[0].content.includes('You summarize a single page')) {
        throw new Error('upstream 500');
      }
      return JSON.stringify(VALID_PROFILE);
    };
    const result = await extractProfileFromPages(
      DOMAIN,
      [page('https://example.com/about', long)],
      emptySignals(),
      { chat, model: 'glm-5.2' },
    );
    expect(result.degradedPages).toBe(1);
    expect(result.profile.name).toBe('Example Inc');
  });

  test('merges harvested socials into the profile even when the model omits them', async () => {
    const chat: ChatFn = async () => JSON.stringify({ ...VALID_PROFILE, socials: [] });
    const result = await extractProfileFromPages(
      DOMAIN,
      [page('https://example.com/', 'short home page')],
      emptySignals({ socials: [{ platform: 'github', url: 'https://github.com/example' }] }),
      { chat, model: 'glm-5.2' },
    );
    expect(result.profile.socials).toEqual([
      { platform: 'github', url: 'https://github.com/example' },
    ]);
  });

  test('still runs the repair loop on the reduce call without re-running the map pass', async () => {
    const long = `# About\n\n${'a'.repeat(5_000)}`;
    let mapCalls = 0;
    let reduceCalls = 0;
    const chat: ChatFn = async ({ messages }) => {
      if (messages[0].content.includes('You summarize a single page')) {
        mapCalls += 1;
        return JSON.stringify({
          pageKind: 'about',
          purpose: 'ok',
          keyPoints: [],
          entities: [],
          pricingTiers: [],
          quotes: [],
        });
      }
      reduceCalls += 1;
      return reduceCalls === 1
        ? JSON.stringify({ ...VALID_PROFILE, sources: [] })
        : JSON.stringify(VALID_PROFILE);
    };
    const result = await extractProfileFromPages(
      DOMAIN,
      [page('https://example.com/about', long)],
      emptySignals(),
      { chat, model: 'glm-5.2' },
    );
    expect(mapCalls).toBe(1);
    expect(reduceCalls).toBe(2);
    expect(result.attempts).toBe(2);
  });

  test('reports extraction_failed once the reduce repair budget is exhausted', async () => {
    const chat: ChatFn = async ({ messages }) => {
      if (messages[0].content.includes('You summarize a single page')) {
        return JSON.stringify({
          pageKind: 'about',
          purpose: 'ok',
          keyPoints: [],
          entities: [],
          pricingTiers: [],
          quotes: [],
        });
      }
      return JSON.stringify({ ...VALID_PROFILE, sources: [] });
    };
    await expect(
      extractProfileFromPages(
        DOMAIN,
        [page('https://example.com/about', `# About\n\n${'a'.repeat(5_000)}`)],
        emptySignals(),
        { chat, model: 'glm-5.2' },
      ),
    ).rejects.toThrow(EnrichmentError);
  });
});
