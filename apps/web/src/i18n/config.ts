import { getRequestConfig } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { locales } from './catalog.mjs';

export type Locale = (typeof locales)[number];
export { defaultLocale, localeNames, locales } from './catalog.mjs';

export default getRequestConfig(async ({ locale }) => {
  // Validate that the incoming `locale` parameter is valid
  if (!locales.includes(locale as Locale)) {
    notFound();
  }

  return {
    locale: locale as string,
    messages: (await import(`../../translations/${locale}.json`)).default,
  };
});
