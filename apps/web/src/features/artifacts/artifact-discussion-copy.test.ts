import { expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import { readFileSync } from 'node:fs';

const locales = ['en', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'sr', 'zh'];
function leaves(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, item]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof item === 'string'
        ? { [path]: item }
        : leaves(item as Record<string, unknown>, path);
    }),
  );
}
const catalog = (locale: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../translations/${locale}.json`, import.meta.url), 'utf8'),
  );
const english = leaves(catalog('en').artifacts.discussion);

for (const locale of locales)
  test(`${locale} has every discussion label and valid count/agent messages`, () => {
    const messages = catalog(locale);
    const copy = leaves(messages.artifacts.discussion);
    expect(Object.keys(copy).sort()).toEqual(Object.keys(english).sort());
    for (const value of Object.values(copy)) expect(value.trim().length).toBeGreaterThan(0);
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages,
      onError: (error) => errors.push(error.message),
    });
    for (const count of [1, 2, 5]) {
      expect(t('artifacts.discussion.sendToAgent', { count })).toContain(String(count));
      expect(t('artifacts.discussion.retrySend', { count })).toContain(String(count));
      expect(t('artifacts.discussion.unshareComments', { count })).toContain(String(count));
    }
    const batch = t('artifacts.discussion.sendBatchHint', { count: 100, total: 101 });
    expect(batch).toContain('100');
    expect(batch).toContain('101');
    expect(t('artifacts.discussion.sendNew', { agent: 'Writer' })).toContain('Writer');
    expect(t('artifacts.discussion.annotationLoading')).toBe(copy.annotationLoading);
    const unavailable = t('artifacts.discussion.annotationUnavailable', {
      refresh: 'REFRESH_TEST',
      actions: 'ACTIONS_TEST',
    });
    expect(unavailable).toContain('REFRESH_TEST');
    expect(unavailable).toContain('ACTIONS_TEST');
    expect(errors).toEqual([]);
  });
