import { describe, expect, test } from 'bun:test';
import { humanizeSearchQuery } from './search-query';

describe('humanizeSearchQuery', () => {
  test('the reported bug: a site: scope reads as English, not as syntax', () => {
    expect(humanizeSearchQuery('site:daytona.io Daytona sandboxes')).toBe(
      'Daytona sandboxes on daytona.io',
    );
  });

  test('the scope reads the same wherever the model puts it', () => {
    expect(humanizeSearchQuery('Daytona sandboxes site:daytona.io')).toBe(
      'Daytona sandboxes on daytona.io',
    );
  });

  test('plain text is returned untouched', () => {
    expect(humanizeSearchQuery('Daytona company developer infrastructure')).toBe(
      'Daytona company developer infrastructure',
    );
  });

  test('a scheme, host and path all reduce to the same host', () => {
    for (const scope of ['daytona.io', 'https://daytona.io', 'www.daytona.io', 'daytona.io/docs']) {
      expect(humanizeSearchQuery(`pricing site:${scope}`)).toBe('pricing on daytona.io');
    }
  });

  test('several scopes are alternatives, and read as such', () => {
    expect(humanizeSearchQuery('pricing site:a.com OR site:b.com')).toBe(
      'pricing on a.com or b.com',
    );
    expect(humanizeSearchQuery('pricing site:a.com site:b.com site:c.com')).toBe(
      'pricing on a.com, b.com or c.com',
    );
  });

  test('the same site twice is one site', () => {
    expect(humanizeSearchQuery('pricing site:a.com site:www.a.com')).toBe('pricing on a.com');
  });

  test('operators that shape the engine, not the subject, are dropped', () => {
    expect(humanizeSearchQuery('filetype:pdf annual report')).toBe('annual report');
    expect(humanizeSearchQuery('intitle:"annual report" revenue')).toBe('revenue');
    expect(humanizeSearchQuery('sandbox after:2024 before:2025')).toBe('sandbox');
    expect(humanizeSearchQuery('docs inurl:api intext:webhook')).toBe('docs');
  });

  test('an excluded term is removed rather than reworded', () => {
    expect(humanizeSearchQuery('sandbox pricing -site:pinterest.com')).toBe('sandbox pricing');
    expect(humanizeSearchQuery('sandbox -docker -"stock photo"')).toBe('sandbox');
  });

  test('a quoted phrase keeps its quotes — that is punctuation, not syntax', () => {
    expect(humanizeSearchQuery('"exact phrase" site:a.com')).toBe('"exact phrase" on a.com');
  });

  /**
   * The trap this module exists to avoid. A `\w+:` stripper eats `https:` and
   * throws away the URL the query was about.
   */
  test('a URL in the query survives', () => {
    expect(humanizeSearchQuery('https://daytona.io/docs pricing')).toBe(
      'https://daytona.io/docs pricing',
    );
  });

  test('an unknown prefix is text, not an operator', () => {
    expect(humanizeSearchQuery('error: connection refused')).toBe('error: connection refused');
    expect(humanizeSearchQuery('typescript ts2322: type error')).toBe(
      'typescript ts2322: type error',
    );
  });

  test('the result is never blank', () => {
    // Nothing but a scope — the site is what was looked at, so it becomes the label.
    expect(humanizeSearchQuery('site:daytona.io')).toBe('daytona.io');
    // Nothing but strippable operators — the original beats an empty row.
    expect(humanizeSearchQuery('filetype:pdf')).toBe('filetype:pdf');
    expect(humanizeSearchQuery('   ')).toBe('');
    expect(humanizeSearchQuery(undefined)).toBe('');
    expect(humanizeSearchQuery(null)).toBe('');
  });

  test('words never fuse where an operator was removed', () => {
    expect(humanizeSearchQuery('sandbox filetype:pdf pricing')).toBe('sandbox pricing');
    expect(humanizeSearchQuery('a inurl:x intitle:y b')).toBe('a b');
  });

  test('lowercase "or" is a word, uppercase OR is glue', () => {
    expect(humanizeSearchQuery('cats or dogs')).toBe('cats or dogs');
    expect(humanizeSearchQuery('cats OR dogs')).toBe('cats dogs');
  });

  /**
   * A `/g` regex hoisted to module scope carries `lastIndex` between calls, so
   * every second query would start matching mid-string and keep its operators.
   * Same input twice, same output twice.
   */
  test('repeated calls are stable', () => {
    const q = 'site:daytona.io Daytona sandboxes';
    expect(humanizeSearchQuery(q)).toBe(humanizeSearchQuery(q));
    expect(humanizeSearchQuery(q)).toBe('Daytona sandboxes on daytona.io');
  });

  test('operator matching is case-insensitive', () => {
    expect(humanizeSearchQuery('SITE:daytona.io sandboxes')).toBe('sandboxes on daytona.io');
  });
});
