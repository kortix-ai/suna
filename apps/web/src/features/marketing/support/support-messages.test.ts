import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { locales } from '@/i18n/config';

/**
 * Guards the `support` message namespace against the two failures that a
 * `t('…')` call cannot report until someone loads the page in that language.
 *
 * 1. A key referenced by a page but absent from `en.json`. next-intl renders the
 *    key path as the visible string, so the page "works" and ships gibberish.
 * 2. A key present in `en.json` and missing from one of the other seven locales.
 *    `scripts/audit-translations.mjs` covers this repo-wide, but it is a manual
 *    script and is currently red for an unrelated `appHomePage` gap — so a new
 *    hole here would land inside an already-failing report and be missed.
 *
 * The page is `'use client'` and its copy is anonymous-locale English in local
 * dev (a pre-existing `x-locale` request/response header mismatch in
 * `src/i18n/request.ts` — the `<html lang>`, canonical and hreflang are all
 * correct, only the body copy falls back). That makes a rendered-DOM assertion
 * unable to prove the other seven locales, which is exactly why this test reads
 * the message files directly.
 *
 * `support.credits` used to be the second namespace here. The credits guide is
 * reference material, so it moved to the English-only docs tree at
 * `content/docs/credits.mdx` and took its 61 keys per locale with it.
 */

const TRANSLATIONS = path.join(import.meta.dir, '../../../../translations');
const PAGES = ['src/app/(public)/(marketing)/support/page.tsx'];

/** `useTranslations('support.hub')` → the namespace the file's `t` is bound to. */
function namespaceOf(source: string): string {
  const match = source.match(/useTranslations\('(support\.[a-z]+)'\)/);
  if (!match) throw new Error('no support.* useTranslations call found');
  return match[1];
}

/** Every `t('key')` in the file. */
function keysUsed(source: string): string[] {
  return [...source.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]);
}

function messages(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(TRANSLATIONS, `${locale}.json`), 'utf8')).support;
}

function flatten(value: unknown, prefix = '', out: Record<string, string> = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flatten(nested, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (typeof value === 'string') {
    out[prefix] = value;
  }
  return out;
}

describe('support message namespace', () => {
  test('every key the pages ask for exists in en.json', () => {
    const en = messages('en');
    const seen: string[] = [];

    for (const page of PAGES) {
      const source = fs.readFileSync(path.join(process.cwd(), page), 'utf8');
      const namespace = namespaceOf(source).replace(/^support\./, '');
      const scope = flatten((en as Record<string, unknown>)[namespace]);
      const used = keysUsed(source);

      expect(used.length).toBeGreaterThan(10);
      for (const key of used) {
        expect(scope[key], `${page} asks for support.${namespace}.${key}`).toBeString();
        expect(scope[key]!.trim().length, `support.${namespace}.${key} is empty`).toBeGreaterThan(0);
        seen.push(`${namespace}.${key}`);
      }
    }

    // Nothing is defined and then left unrendered. A stranded key is copy
    // somebody wrote, translated eight times, and wired to nothing.
    const defined = Object.keys(flatten(en));
    expect(defined.filter((key) => !seen.includes(key))).toEqual([]);
  });

  test.each(locales.filter((locale) => locale !== 'en'))(
    '%s has every support key en.json has, non-empty',
    (locale) => {
      const en = Object.keys(flatten(messages('en'))).sort();
      const translated = flatten(messages(locale));

      expect(Object.keys(translated).sort()).toEqual(en);
      for (const key of en) {
        expect(translated[key]!.trim().length, `support.${key} empty in ${locale}`).toBeGreaterThan(
          0,
        );
      }
    },
  );
});
