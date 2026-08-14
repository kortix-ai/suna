import { getServerPublicEnv } from '@/lib/public-env-server';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { createServerClient } from '@supabase/ssr';
import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { defaultLocale, type Locale } from './config';
import { getUserLocale, normalizeLocale } from './locale';

// Set only by desktop/build.mjs (static export for the Electron shell).
const IS_DESKTOP_BUILD = process.env.KORTIX_DESKTOP_BUILD === '1';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale: Locale = defaultLocale;

  // A static export has no request, so cookies(), headers(), and the Supabase
  // profile lookup below are all unavailable. Every source this resolver
  // consults is request-scoped, so the desktop bundle ships the default locale
  // and switches language client-side instead.
  if (IS_DESKTOP_BUILD) {
    return {
      locale: defaultLocale,
      messages: (await import(`../../translations/${defaultLocale}.json`)).default,
    };
  }

  const cookieStore = await cookies();
  const headersList = await headers();

  // Priority 1: Check user profile preference (if authenticated).
  // This is the only persisted source that can switch the app away from English.
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
      },
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const userLocale = getUserLocale(user);
    if (userLocale) {
      locale = userLocale;
      return {
        locale,
        messages: (await import(`../../translations/${locale}.json`)).default,
      };
    }
  } catch (error) {
    // User might not be authenticated, continue with explicit route locale or default.
  }

  // Priority 2: If locale is provided in the URL path (e.g., /de, /it), use it for marketing pages
  // This allows SEO-friendly URLs like /de, /it for marketing content
  const urlLocale = normalizeLocale((await requestLocale) || headersList.get('x-locale'));
  if (urlLocale) {
    locale = urlLocale;
    return {
      locale,
      messages: (await import(`../../translations/${locale}.json`)).default,
    };
  }

  // Priority 3: Default to English. Browser headers, timezones, cookies, and
  // localStorage never change the language automatically.
  return {
    locale,
    messages: (await import(`../../translations/${locale}.json`)).default,
  };
});
