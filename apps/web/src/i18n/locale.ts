import { defaultLocale, locales, type Locale } from './config';

export const LOCALE_COOKIE_NAME = 'locale';
export const LOCALE_CHANGE_EVENT = 'locale-change';
export const LOCALE_COOKIE_MAX_AGE = 31536000;

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

export function getCookieLocale(cookieValue: string | undefined | null): Locale | null {
  return normalizeLocale(cookieValue);
}

export function getDocumentCookieLocale(cookieString: string): Locale | null {
  const match = cookieString
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE_NAME}=`));

  if (!match) return null;
  return getCookieLocale(decodeURIComponent(match.split('=').slice(1).join('=')));
}

export function getLocalStorageLocale(storage: Pick<Storage, 'getItem'>): Locale | null {
  return normalizeLocale(storage.getItem(LOCALE_COOKIE_NAME));
}

export function createLocaleCookie(locale: Locale): string {
  return `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function getBrowserLocale(
  user: UserWithLocale,
  detectLocale: () => Locale = () => defaultLocale,
): Locale {
  if (typeof window === 'undefined') return defaultLocale;

  return (
    getUserLocale(user) ??
    getDocumentCookieLocale(document.cookie) ??
    getLocalStorageLocale(window.localStorage) ??
    detectLocale()
  );
}

export function persistBrowserLocale(locale: Locale) {
  if (typeof document !== 'undefined') {
    document.cookie = createLocaleCookie(locale);
  }

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LOCALE_COOKIE_NAME, locale);
  }
}

export function hasExplicitBrowserLocalePreference(user: UserWithLocale): boolean {
  if (getUserLocale(user)) return true;
  if (typeof window === 'undefined') return false;

  return Boolean(
    getDocumentCookieLocale(document.cookie) ??
      getLocalStorageLocale(window.localStorage),
  );
}
