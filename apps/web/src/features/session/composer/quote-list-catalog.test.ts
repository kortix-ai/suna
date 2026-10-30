import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';

import de from '../../../../translations/de.json';
import en from '../../../../translations/en.json';
import es from '../../../../translations/es.json';
import fr from '../../../../translations/fr.json';
import it from '../../../../translations/it.json';
import ja from '../../../../translations/ja.json';
import pt from '../../../../translations/pt.json';
import sr from '../../../../translations/sr.json';
import zh from '../../../../translations/zh.json';

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
