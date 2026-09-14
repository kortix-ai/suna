import { localizedKindCopy } from '@/components/projects/schedule/schedule-copy';
import { faq } from '@/features/marketing/faq/content';
import { openSource } from '@/features/marketing/open-source/content';
import { localizedSlashActions } from '@/features/session/composer/menus/slash-actions';
import { getProviderGuide, getScimGuide } from '@/features/sso-setup/guides';
import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';

import de from '../../translations/de.json';
import en from '../../translations/en.json';
import es from '../../translations/es.json';
import fr from '../../translations/fr.json';
import it from '../../translations/it.json';
import ja from '../../translations/ja.json';
import pt from '../../translations/pt.json';
import sr from '../../translations/sr.json';
import zh from '../../translations/zh.json';
import { localizeUiCatalog } from './localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from './remaining-ui-translation-keys.generated';

const srTranslator = createTranslator({
  locale: 'sr',
  messages: sr,
  namespace: 'hardcodedUi.i18nComplete',
});

const localeCatalogs = { en, de, it, zh, ja, pt, fr, es, sr } as const;

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\s*([A-Za-z_][\w.-]*)\s*(?=[,}])/g)].map((match) => match[1]).sort();
}

describe('complete UI localization', () => {
  test('localizes nested display text, preserves React elements, and keeps unknown fallbacks', () => {
    const icon = createElement('span', { 'data-testid': 'icon' });
    const source = {
      title: 'Actions',
      nested: [{ description: 'Compute' }, { description: 'Unmapped fallback' }],
      icon,
    };

    const localized = localizeUiCatalog(source, srTranslator, REMAINING_UI_TRANSLATION_KEYS);

    expect(localized.title).toBe('Радње');
    expect(localized.nested[0]?.description).toBe('Израчунај');
    expect(localized.nested[1]?.description).toBe('Unmapped fallback');
    expect(localized.icon).toBe(icon);
  });

  test('preserves an empty catalog value without requesting an empty translation key', () => {
    const localized = localizeUiCatalog(
      { description: '' },
      srTranslator,
      { '': 'texte3b0c44298fc' },
    );

    expect(localized.description).toBe('');
  });

  test('renders Serbian Cyrillic through a menu, a copy factory, and both identity guides', () => {
    const slashAction = localizedSlashActions(srTranslator)[0];
    const schedule = localizedKindCopy(srTranslator).cron;
    const sso = getProviderGuide('entra', srTranslator);
    const scim = getScimGuide('entra', srTranslator);

    expect(slashAction?.label).toMatch(/[А-Яа-яЉЊЂЋЏљњђћџ]/u);
    expect(schedule.title).toMatch(/[А-Яа-яЉЊЂЋЏљњђћџ]/u);
    expect(sso?.steps[0]?.title).toMatch(/[А-Яа-яЉЊЂЋЏљњђћџ]/u);
    expect(scim?.steps[0]?.title).toMatch(/[А-Яа-яЉЊЂЋЏљњђћџ]/u);
  });

  test('localizes every FAQ entry and open-source link added after the generated catalog', () => {
    const localizedFaq = localizeUiCatalog(faq, srTranslator, REMAINING_UI_TRANSLATION_KEYS);
    const localizedOpenSource = localizeUiCatalog(
      openSource,
      srTranslator,
      REMAINING_UI_TRANSLATION_KEYS,
    );

    for (const [index, item] of faq.items.entries()) {
      expect(localizedFaq.items[index]?.question).not.toBe(item.question);
      expect(localizedFaq.items[index]?.answer).not.toBe(item.answer);
      expect(localizedFaq.items[index]?.question).toMatch(/[А-Яа-яЉЊЂЋЏљњђћџ]/u);
      expect(localizedFaq.items[index]?.answer).toMatch(/[А-Яа-яЉЊЂЋЏљњђћџ]/u);
    }
    expect(localizedOpenSource.aboutLabel).toBe('Зашто га градимо');
    expect(localizedOpenSource.repoLabel).toBe('Прочитајте изворни кôд');
  });

  test('keeps every locale in exact key and placeholder parity with English', () => {
    const english = en.hardcodedUi.i18nComplete;
    const englishKeys = Object.keys(english).sort();

    for (const [locale, catalog] of Object.entries(localeCatalogs)) {
      const messages = catalog.hardcodedUi.i18nComplete as Record<string, string>;
      expect(Object.keys(messages).sort(), locale).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(messages[key]?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
        expect(placeholders(messages[key] ?? ''), `${locale}:${key}`).toEqual(
          placeholders(english[key as keyof typeof english]),
        );
      }
    }
  });

  test('keeps every generated translation-map key in the English catalog', () => {
    const english = en.hardcodedUi.i18nComplete as Record<string, string>;
    const sourceRoot = join(import.meta.dir, '..');
    const generatedFiles = readdirSync(sourceRoot, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('-translation-keys.generated.ts'));

    for (const file of generatedFiles) {
      const source = readFileSync(join(sourceRoot, file), 'utf8');
      const keys = [...source.matchAll(/:\s*'(text[0-9a-f]{12})'/g)]
        .map((match) => match[1])
        .filter((key) => key !== 'texte3b0c44298fc');
      expect(keys.length, file).toBeGreaterThan(0);
      for (const key of keys) expect(english[key], `${file}:${key}`).toBeDefined();
    }
  });
  test('never ships a translation-key reference as a catalog value', () => {
    // A broken re-key pass once wrote `i18nComplete.text…` and bare `text…` ids
    // into the value slot. `.raw()` returns those verbatim, so users read a key
    // id out of a toast instead of a sentence.
    const keyReference = /^(?:i18nComplete\.)?text[0-9a-f]{12}$/;

    for (const [locale, catalog] of Object.entries(localeCatalogs)) {
      const messages = catalog.hardcodedUi.i18nComplete as Record<string, string>;
      for (const [key, value] of Object.entries(messages)) {
        expect(keyReference.test(value), `${locale}:${key} = ${value}`).toBe(false);
      }
    }
  });

  test('resolves every i18nComplete key the app reads at runtime', () => {
    const english = en.hardcodedUi.i18nComplete as Record<string, string>;
    const sourceRoot = join(import.meta.dir, '..');
    const callSite =
      /(?:tI18nHardcoded|tHardcodedUi|tI18nComplete)(?:\.raw)?\(\s*'(?:i18nComplete\.)?(text[0-9a-f]{12})'/g;
    const sources = readdirSync(sourceRoot, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));

    let referenced = 0;
    for (const file of sources) {
      const source = readFileSync(join(sourceRoot, file), 'utf8');
      for (const match of source.matchAll(callSite)) {
        referenced += 1;
        expect(english[match[1]], `${file}:${match[1]}`).toBeDefined();
      }
    }
    expect(referenced).toBeGreaterThan(1000);
  });
});
