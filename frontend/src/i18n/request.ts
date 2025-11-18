import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { locales, defaultLocale, type Locale } from './config';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale: Locale = defaultLocale;
  const cookieStore = await cookies();
  const headersList = await headers();
  
  // Priority 1: Check user profile preference (if authenticated)
  // This ALWAYS takes precedence - user explicitly set it in settings
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {
            // No-op for server-side
          },
        },
      }
    );
    
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.user_metadata?.locale && locales.includes(user.user_metadata.locale as Locale)) {
      locale = user.user_metadata.locale as Locale;
      return {
        locale,
        messages: (await import(`../../translations/${locale}.json`)).default
      };
    }
  } catch (error) {
    // User might not be authenticated, continue with other methods
  }
  
  // Priority 2: Check cookie (explicit user preference)
  const localeCookie = cookieStore.get('locale')?.value;
  if (localeCookie && locales.includes(localeCookie as Locale)) {
    locale = localeCookie as Locale;
    return {
      locale,
      messages: (await import(`../../translations/${locale}.json`)).default
    };
  }
  
  // Priority 3: If locale is provided in the URL path (e.g., /de, /it), use it for marketing pages
  // This allows SEO-friendly URLs like /de, /it for marketing content
  // Only used if user hasn't set an explicit preference
  const urlLocale = requestLocale || headersList.get('x-locale');
  if (urlLocale && locales.includes(urlLocale as Locale)) {
    locale = urlLocale as Locale;
    return {
      locale,
      messages: (await import(`../../translations/${locale}.json`)).default
    };
  }
  
  // Priority 4: Try to detect from Accept-Language header (browser language)
  const acceptLanguage = headersList.get('accept-language');
  if (acceptLanguage) {
    const browserLocale = acceptLanguage.split(',')[0].split('-')[0].toLowerCase();
    if (locales.includes(browserLocale as Locale)) {
      locale = browserLocale as Locale;
    }
  }

  // Priority 5: Default to English
  return {
    locale,
    messages: (await import(`../../translations/${locale}.json`)).default
  };
});

