import { locales } from './catalog.mjs';

export type Locale = (typeof locales)[number];
export { defaultLocale, localeNames, locales } from './catalog.mjs';
