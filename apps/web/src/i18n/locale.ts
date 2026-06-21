import { defaultLocale, locales, type Locale } from './config';

export const LOCALE_CHANGE_EVENT = 'locale-change';

type UserWithLocale = {
  user_metadata?: {
    locale?: unknown;
  } | null;
} | null;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && locales.includes(value as Locale);
}

export function normalizeLocale(value: unknown): Locale | null {
  if (isLocale(value)) return value;
  if (typeof value !== 'string') return null;

  const base = value.toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : null;
}

export function getUserLocale(user: UserWithLocale): Locale | null {
  return normalizeLocale(user?.user_metadata?.locale);
}

export function getExplicitLocale(user: UserWithLocale): Locale {
  return getUserLocale(user) ?? defaultLocale;
}
