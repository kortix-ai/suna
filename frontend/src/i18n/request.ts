import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { locales, defaultLocale, type Locale } from './config';

export default getRequestConfig(async () => {
  let locale: Locale = defaultLocale;
  const cookieStore = await cookies();
  
  // Priority 1: Check user profile preference (if authenticated)
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
    console.debug('Could not fetch user locale from profile:', error);
  }
  
  // Priority 2: Check cookie
  const localeCookie = cookieStore.get('locale')?.value;
  if (localeCookie && locales.includes(localeCookie as Locale)) {
    locale = localeCookie as Locale;
    return {
      locale,
      messages: (await import(`../../translations/${locale}.json`)).default
    };
  }
  
  // Priority 3: Try to detect from Accept-Language header
  const headersList = await headers();
  const acceptLanguage = headersList.get('accept-language');
  if (acceptLanguage) {
    const browserLocale = acceptLanguage.split(',')[0].split('-')[0].toLowerCase();
    if (locales.includes(browserLocale as Locale)) {
      locale = browserLocale as Locale;
    }
  }

  return {
    locale,
    messages: (await import(`../../translations/${locale}.json`)).default
  };
});

