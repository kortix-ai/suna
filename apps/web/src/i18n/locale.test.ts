import { describe, expect, test } from 'bun:test';

import { defaultLocale, localeNames, locales } from './config';
import {
  getExplicitLocale,
  getRouteLocale,
  getUserLocale,
  normalizeLocale,
} from './locale';

describe('explicit locale resolution', () => {
  test('defaults to English without a profile locale', () => {
    expect(getExplicitLocale(null)).toBe(defaultLocale);
    expect(getExplicitLocale({ user_metadata: {} })).toBe(defaultLocale);
  });

  test('uses only the authenticated profile locale when present', () => {
    expect(getExplicitLocale({ user_metadata: { locale: 'de' } })).toBe('de');
    expect(getExplicitLocale({ user_metadata: { locale: 'pt-BR' } })).toBe('pt');
  });

  test('ignores unsupported profile locale values', () => {
    expect(getUserLocale({ user_metadata: { locale: 'nl' } })).toBeNull();
    expect(getExplicitLocale({ user_metadata: { locale: 'nl' } })).toBe(defaultLocale);
  });

  test('normalizes supported locale tags but does not infer from arbitrary values', () => {
    expect(normalizeLocale('fr-FR')).toBe('fr');
    expect(normalizeLocale('ja_JP')).toBe('ja');
    expect(normalizeLocale('Europe/Berlin')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });

  test('ships Serbian and normalizes both Serbian script tags', () => {
    expect(locales).toContain('sr');
    expect(localeNames.sr).toBe('Српски');
    expect(normalizeLocale('sr-Latn')).toBe('sr');
    expect(normalizeLocale('sr_Cyrl')).toBe('sr');
  });

  test('explicit route header wins over the next-intl default locale', () => {
    expect(getRouteLocale('en', 'de')).toBe('de');
    expect(getRouteLocale('en', 'sr')).toBe('sr');
    expect(getRouteLocale('fr', null)).toBe('fr');
  });
});
