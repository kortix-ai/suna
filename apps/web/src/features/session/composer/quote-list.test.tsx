import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';
import de from '../../../../translations/de.json';
import en from '../../../../translations/en.json';
import es from '../../../../translations/es.json';
import fr from '../../../../translations/fr.json';
import it from '../../../../translations/it.json';
import ja from '../../../../translations/ja.json';
import pt from '../../../../translations/pt.json';
import sr from '../../../../translations/sr.json';
import zh from '../../../../translations/zh.json';
import { QuoteList, type QuoteListLabels, type QuoteListProps } from './quote-list';

/** The labels the composer builds, from the real English messages. */
const englishLabels = (count: number): QuoteListLabels => {
  const threads = createTranslator({ locale: 'en', messages: en, namespace: 'threads' });
  const input = createTranslator({
    locale: 'en',
    messages: en,
    namespace: 'hardcodedUi.componentsSessionSessionChatInput',
  });
  return {
    count: threads('quoteCount', { count }),
    expand: threads('expandQuotes'),
    collapse: threads('collapseQuotes'),
    remove: input('removeQuoteAriaLabel'),
  };
};

const render = (props: Partial<QuoteListProps>) => {
  const quotesToRender = props.quotes ?? [];
  return renderToStaticMarkup(
    <TooltipProvider>
      <QuoteList
        quotes={[]}
        labels={englishLabels(quotesToRender.length)}
        onRemove={() => {}}
        {...props}
      />
    </TooltipProvider>,
  );
};

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const quotes = [
  { id: 'q1', text: 'first quoted passage' },
  { id: 'q2', text: 'second quoted passage' },
  { id: 'q3', text: 'third quoted passage' },
];

describe('QuoteList — the reply quotes card above the composer', () => {
  test('renders nothing at all for an empty list', () => {
    // The composer mounts this in an `empty:hidden` wrapper; any element here
    // would paint an empty bordered card above the input.
    expect(render({})).toBe('');
  });

  test('the header counts the quotes, singular and plural', () => {
    expect(render({ quotes: quotes.slice(0, 1) })).toContain('1 Quote<');
    expect(render({ quotes })).toContain('3 Quotes<');
  });

  test('copies the queue card chrome: bordered card, header row, scrolling list', () => {
    const markup = render({ quotes });
    expect(markup).toContain(
      'class="bg-background border-border flex w-full flex-col rounded-lg border p-1"',
    );
    expect(markup).toContain('class="flex items-center gap-2 py-0.5 pr-1 pl-2"');
    expect(markup).toContain('max-h-40 overflow-y-auto');
  });

  test('one row per quote, in order, one truncated line with the full text in title', () => {
    const markup = render({ quotes });
    const at = (id: string) => markup.indexOf(`data-quote-id="${id}"`);
    expect(at('q1')).toBeGreaterThan(-1);
    expect(at('q1')).toBeLessThan(at('q2'));
    expect(at('q2')).toBeLessThan(at('q3'));
    expect(markup).toContain('title="second quoted passage"');
    expect(count(markup, 'text-foreground min-w-0 flex-1 truncate text-sm')).toBe(3);
  });

  test('every row has a Remove quote button, revealed on hover or focus and always on touch', () => {
    const markup = render({ quotes });
    expect(count(markup, 'aria-label="Remove quote"')).toBe(3);
    expect(markup).toContain('group-hover/quote:opacity-100');
    expect(markup).toContain('group-focus-within/quote:opacity-100');
    expect(markup).toContain('pointer-coarse:opacity-100');
  });

  test('expanded by default: the toggle says so and controls the list', () => {
    const markup = render({ quotes });
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Collapse quotes"');
    const controls = /aria-controls="([^"]+)"/.exec(markup)?.[1];
    expect(controls).toBeTruthy();
    expect(markup).toContain(`<ul id="${controls}"`);
  });

  test('collapsed: the rows are hidden, the count stays, the toggle flips', () => {
    const markup = render({ quotes, defaultCollapsed: true });
    expect(markup).toContain('3 Quotes<');
    expect(markup).not.toContain('data-quote-id');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand quotes"');
  });
});

describe('quoteListRemove — what a row X does', () => {
  test('removes that quote and moves focus to the composer only for a keyboard press', async () => {
    const { quoteListRemove } = await import('./quote-list');
    const removed: string[] = [];
    const focused: number[] = [];
    const deps = { onRemove: (id: string) => removed.push(id), focusComposer: () => focused.push(1) };
    quoteListRemove({ id: 'q2', detail: 1 }, deps);
    expect(removed).toEqual(['q2']);
    expect(focused).toEqual([]);
    quoteListRemove({ id: 'q3', detail: 0 }, deps);
    expect(removed).toEqual(['q2', 'q3']);
    expect(focused).toEqual([1]);
  });
});

describe('quote card copy — every locale', () => {
  const locales = { de, en, es, fr, it, ja, pt, sr, zh };

  test('English reads "1 Quote" and "N Quotes"', () => {
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'threads' });
    expect(t('quoteCount', { count: 1 })).toBe('1 Quote');
    expect(t('quoteCount', { count: 3 })).toBe('3 Quotes');
  });

  test('all nine locales translate the count, expand and collapse keys', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      const t = createTranslator({
        locale,
        messages: messages as typeof en,
        namespace: 'threads',
        onError: (error) => {
          throw new Error(`${locale}: ${error.message}`);
        },
      });
      for (const count of [1, 2, 5]) expect(t('quoteCount', { count })).toContain(String(count));
      expect(t('expandQuotes')).not.toBe('threads.expandQuotes');
      expect(t('collapseQuotes')).not.toBe('threads.collapseQuotes');
      if (locale !== 'en') {
        expect(t('expandQuotes')).not.toBe('Expand quotes');
        expect(t('collapseQuotes')).not.toBe('Collapse quotes');
      }
    }
  });
});
