import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { defaultLocale, type Locale } from './config';
import { getCookieLocale, getUserLocale, normalizeLocale } from './locale';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { getServerPublicEnv } from '@/lib/public-env-server';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale: Locale = defaultLocale;
  const cookieStore = await cookies();
  const headersList = await headers();
  
  // Priority 1: Check cookie FIRST (faster, no API call needed)
  // This is set by middleware or user preference
  const localeCookie = getCookieLocale(cookieStore.get('locale')?.value);
  if (localeCookie) {
    locale = localeCookie;
    return {
      locale,
      messages: (await import(`../../translations/${locale}.json`)).default
    };
  }
  
  // Priority 2: Check user profile preference (if authenticated)
  // Only call getUser() if no cookie preference exists (optimization)
  // This ALWAYS takes precedence over geo-detection - user explicitly set it in settings
  try {
    const runtimeEnv = getServerPublicEnv();
    const supabase = createServerClient(
      process.env.SUPABASE_SERVER_URL || process.env.SUPABASE_URL || runtimeEnv.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY || runtimeEnv.SUPABASE_ANON_KEY,
      {
        cookieOptions: {
          name: KORTIX_SUPABASE_AUTH_COOKIE,
          path: '/',
          sameSite: 'lax',
        },
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
    const userLocale = getUserLocale(user);
    if (userLocale) {
      locale = userLocale;
      return {
        locale,
        messages: (await import(`../../translations/${locale}.json`)).default
      };
    }
  } catch (error) {
    // User might not be authenticated, continue with other methods
  }
  
  // Priority 3: If locale is provided in the URL path (e.g., /de, /it), use it for marketing pages
  // This allows SEO-friendly URLs like /de, /it for marketing content
  // Only used if user hasn't set an explicit preference
  const urlLocale = normalizeLocale((await requestLocale) || headersList.get('x-locale'));
  if (urlLocale) {
    locale = urlLocale;
    return {
      locale,
      messages: (await import(`../../translations/${locale}.json`)).default
    };
  }
  
  // Priority 4: Try to detect from Accept-Language header (browser language)
  const acceptLanguage = headersList.get('accept-language');
  if (acceptLanguage) {
    const browserLocale = normalizeLocale(acceptLanguage.split(',')[0]);
    if (browserLocale) {
      locale = browserLocale as Locale;
    }
  }

  // Priority 5: Default to English
  return {
    locale,
    messages: (await import(`../../translations/${locale}.json`)).default
  };
});
