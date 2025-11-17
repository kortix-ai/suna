import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { locales, defaultLocale, type Locale } from './config';

export default getRequestConfig(async () => {
  // Get locale from cookie or header, default to 'en'
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get('locale')?.value;
  
  let locale: Locale = defaultLocale;
  
  if (localeCookie && locales.includes(localeCookie as Locale)) {
    locale = localeCookie as Locale;
  } else {
    // Try to detect from Accept-Language header
    const headersList = await headers();
    const acceptLanguage = headersList.get('accept-language');
    if (acceptLanguage) {
      const browserLocale = acceptLanguage.split(',')[0].split('-')[0].toLowerCase();
      if (locales.includes(browserLocale as Locale)) {
        locale = browserLocale as Locale;
      }
    }
  }

  return {
    locale,
        messages: (await import(`../../translations/${locale}.json`)).default
  };
});

