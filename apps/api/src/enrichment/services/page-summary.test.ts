import { describe, expect, test } from 'bun:test';
import type { ChatFn } from './chat-json';
import type { ConsolidatePage } from './consolidate';
import {
  MAP_CONCURRENCY,
  MAP_INPUT_MAX_CHARS,
  PAGE_SUMMARY_THRESHOLD,
  mapPages,
  renderMappedPage,
  summarizePage,
  type MappedPage,
  type PageSummary,
} from './page-summary';

const VALID_SUMMARY: PageSummary = {
  url: 'https://example.com/wrong-url',
  pageKind: 'about',
  purpose: 'Introduces the team.',
  keyPoints: ['Founded in 2019', 'Based in Berlin'],
  entities: ['Ada Lovelace'],
  pricingTiers: [],
  quotes: ['We build tools for builders.'],
};

function page(url: string, markdown: string): ConsolidatePage {
  return { url, markdown, tier: 'priority' };
}

describe('summarizePage', () => {
  test('forces the url to the page actually shown, ignoring what the model echoes', async () => {
    const chat: ChatFn = async () => JSON.stringify(VALID_SUMMARY);
    const result = await summarizePage(page('https://example.com/about', 'x'.repeat(5_000)), {
      chat,
      model: 'glm-5.2',
    });
    expect(result.url).toBe('https://example.com/about');
  });

  test('passes the page url and markdown in the user turn', async () => {
    const seen: string[] = [];
    const chat: ChatFn = async ({ messages }) => {
      seen.push(messages[messages.length - 1].content);
      return JSON.stringify(VALID_SUMMARY);
    };
    await summarizePage(page('https://example.com/about', 'THE-PAGE-BODY'), {
      chat,
      model: 'glm-5.2',
    });
    expect(seen[0]).toContain('https://example.com/about');
    expect(seen[0]).toContain('THE-PAGE-BODY');
  });

  test('throws on a schema-invalid response rather than repairing', async () => {
    const chat: ChatFn = async () => JSON.stringify({ pageKind: 'not-a-real-kind' });
    await expect(
      summarizePage(page('https://example.com/about', 'x'.repeat(5_000)), { chat, model: 'm' }),
    ).rejects.toThrow();
  });

  test('throws on an unparseable response', async () => {
    const chat: ChatFn = async () => 'not json at all';
    await expect(
      summarizePage(page('https://example.com/about', 'x'.repeat(5_000)), { chat, model: 'm' }),
    ).rejects.toThrow();
  });

  test('caps the page text sent to the model at MAP_INPUT_MAX_CHARS', async () => {
    const seen: string[] = [];
    const chat: ChatFn = async ({ messages }) => {
      seen.push(messages[messages.length - 1].content);
      return JSON.stringify(VALID_SUMMARY);
    };
    const oversized = 'a'.repeat(MAP_INPUT_MAX_CHARS * 3);
    await summarizePage(page('https://example.com/huge', oversized), { chat, model: 'm' });

    const bodySent = seen[0].slice(seen[0].indexOf('\n\n') + 2);
    expect(bodySent.length).toBeLessThanOrEqual(MAP_INPUT_MAX_CHARS);
    expect(bodySent.length).toBeLessThan(oversized.length);
  });

  test('still summarizes an oversized page rather than skipping or erroring', async () => {
    const chat: ChatFn = async () => JSON.stringify(VALID_SUMMARY);
    const oversized = 'b'.repeat(MAP_INPUT_MAX_CHARS * 5);
    const result = await summarizePage(page('https://example.com/huge', oversized), {
      chat,
      model: 'm',
    });
    expect(result.pageKind).toBe('about');
  });
});

describe('mapPages', () => {
  test('skips the model call for pages at or under the threshold', async () => {
    const short = 'y'.repeat(PAGE_SUMMARY_THRESHOLD);
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      return JSON.stringify(VALID_SUMMARY);
    };
    const result = await mapPages([page('https://example.com/', short)], { chat, model: 'm' });

    expect(calls).toBe(0);
    expect(result.mapped[0]).toEqual({
      url: 'https://example.com/',
      kind: 'excerpt',
      markdown: short,
      degraded: false,
    });
    expect(result.summarizedCount).toBe(0);
  });

  test('makes exactly one model call per page over the threshold', async () => {
    const long = 'y'.repeat(PAGE_SUMMARY_THRESHOLD + 1);
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      return JSON.stringify(VALID_SUMMARY);
    };
    const pages = [
      page('https://example.com/a', long),
      page('https://example.com/b', long),
      page('https://example.com/c', long),
    ];
    const result = await mapPages(pages, { chat, model: 'm' });

    expect(calls).toBe(3);
    expect(result.summarizedCount).toBe(3);
    expect(result.mapped.every((m) => m.kind === 'summary')).toBe(true);
  });

  test('respects a custom threshold', async () => {
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      return JSON.stringify(VALID_SUMMARY);
    };
    await mapPages([page('https://example.com/a', 'short body')], {
      chat,
      model: 'm',
      threshold: 5,
    });
    expect(calls).toBe(1);
  });

  test('degrades a failed map call to a truncated excerpt instead of failing', async () => {
    const long = `# About\n\n${'z'.repeat(PAGE_SUMMARY_THRESHOLD + 1)}`;
    const chat: ChatFn = async ({ messages }) => {
      if (messages[messages.length - 1].content.includes('https://example.com/broken')) {
        throw new Error('upstream 500');
      }
      return JSON.stringify(VALID_SUMMARY);
    };
    const pages = [
      page('https://example.com/broken', long),
      page('https://example.com/ok', long),
    ];

    const result = await mapPages(pages, { chat, model: 'm', excerptChars: 50 });

    expect(result.failedCount).toBe(1);
    expect(result.summarizedCount).toBe(1);
    const broken = result.mapped[0];
    expect(broken.kind).toBe('excerpt');
    if (broken.kind === 'excerpt') {
      expect(broken.degraded).toBe(true);
      expect(broken.markdown.length).toBeLessThanOrEqual(50);
    }
    expect(result.mapped[1].kind).toBe('summary');
  });

  test('preserves input order regardless of completion order', async () => {
    const long = 'w'.repeat(PAGE_SUMMARY_THRESHOLD + 1);
    const chat: ChatFn = async ({ messages }) => {
      const content = messages[messages.length - 1].content;
      if (content.includes('https://example.com/slow')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return JSON.stringify(VALID_SUMMARY);
    };
    const pages = [
      page('https://example.com/slow', long),
      page('https://example.com/fast', long),
    ];
    const result = await mapPages(pages, { chat, model: 'm', concurrency: 2 });

    expect(result.mapped[0].url).toBe('https://example.com/slow');
    expect(result.mapped[1].url).toBe('https://example.com/fast');
  });

  test('never runs more than the configured concurrency at once', async () => {
    const long = 'v'.repeat(PAGE_SUMMARY_THRESHOLD + 1);
    let inFlight = 0;
    let maxInFlight = 0;
    const chat: ChatFn = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return JSON.stringify(VALID_SUMMARY);
    };
    const pages = Array.from({ length: 6 }, (_, i) => page(`https://example.com/p${i}`, long));

    await mapPages(pages, { chat, model: 'm', concurrency: 2 });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  test('defaults to MAP_CONCURRENCY when none is given', async () => {
    const long = 'u'.repeat(PAGE_SUMMARY_THRESHOLD + 1);
    let inFlight = 0;
    let maxInFlight = 0;
    const chat: ChatFn = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return JSON.stringify(VALID_SUMMARY);
    };
    const pages = Array.from({ length: 10 }, (_, i) => page(`https://example.com/p${i}`, long));

    await mapPages(pages, { chat, model: 'm' });

    expect(maxInFlight).toBeLessThanOrEqual(MAP_CONCURRENCY);
  });

  test('every map call throws but still completes with all pages degraded to excerpts', async () => {
    const long = 's'.repeat(PAGE_SUMMARY_THRESHOLD + 1);
    const chat: ChatFn = async () => {
      throw new Error('upstream 500');
    };
    const pages = [
      page('https://example.com/a', long),
      page('https://example.com/b', long),
      page('https://example.com/c', long),
    ];

    const result = await mapPages(pages, { chat, model: 'm', excerptChars: 100 });

    expect(result.failedCount).toBe(3);
    expect(result.summarizedCount).toBe(0);
    expect(result.mapped).toHaveLength(3);
    expect(result.mapped.every((m) => m.kind === 'excerpt' && m.degraded)).toBe(true);
  });
});

describe('renderMappedPage', () => {
  test('renders a summary with its structured fields', () => {
    const mapped: MappedPage = {
      url: 'https://example.com/about',
      kind: 'summary',
      summary: { ...VALID_SUMMARY, url: 'https://example.com/about' },
    };
    const text = renderMappedPage(mapped);
    expect(text).toContain('https://example.com/about');
    expect(text).toContain('summarized');
    expect(text).toContain('Founded in 2019');
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('We build tools for builders.');
  });

  test('omits empty sections rather than rendering blank headings', () => {
    const mapped: MappedPage = {
      url: 'https://example.com/contact',
      kind: 'summary',
      summary: {
        url: 'https://example.com/contact',
        pageKind: 'contact',
        purpose: 'Contact details.',
        keyPoints: [],
        entities: [],
        pricingTiers: [],
        quotes: [],
      },
    };
    const text = renderMappedPage(mapped);
    expect(text).not.toContain('Key points:');
    expect(text).not.toContain('Pricing tiers mentioned:');
    expect(text).not.toContain('Quotes:');
  });

  test('renders an excerpt as raw markdown', () => {
    const mapped: MappedPage = {
      url: 'https://example.com/short',
      kind: 'excerpt',
      markdown: 'Short page body.',
      degraded: false,
    };
    const text = renderMappedPage(mapped);
    expect(text).toContain('https://example.com/short');
    expect(text).toContain('Short page body.');
    expect(text).not.toContain('unavailable');
  });

  test('flags a degraded excerpt so the model knows it is not a full digest', () => {
    const mapped: MappedPage = {
      url: 'https://example.com/broken',
      kind: 'excerpt',
      markdown: 'partial text',
      degraded: true,
    };
    const text = renderMappedPage(mapped);
    expect(text).toContain('unavailable');
  });
});
