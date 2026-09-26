import { getRequestConfig } from 'next-intl/server';
import { locale as rootLocale } from 'next/root-params';
import { defaultLocale, type Locale } from './config';
import { normalizeLocale } from './locale';
import { loadMessages } from './messages';

/**
 * The locale comes from the URL, never from the request.
 *
 * Every page lives under `app/[locale]`. The middleware rewrites the public
 * URL onto that segment: an explicit `/de/...` prefix, else the profile locale
 * of the signed-in user, else English. `next/root-params` reads the segment
 * without `headers()` or `cookies()`, so marketing pages render statically,
 * once per locale.
 *
 * Server Actions and Route Handlers have no root params. They fall back to the
 * `X-NEXT-INTL-LOCALE` request header that the middleware sets on the rewrite.
 * Those surfaces are request-bound already, so the header read costs nothing.
 */
async function readRootLocale(): Promise<Locale | null> {
  try {
    return normalizeLocale(await rootLocale());
  } catch {
    return null;
  }
}

export default getRequestConfig(async (params) => {
  // Do NOT destructure `requestLocale`: it is a getter that reads headers(),
  // and touching it opts every page into dynamic rendering.
  const locale =
    (await readRootLocale()) ?? normalizeLocale(await params.requestLocale) ?? defaultLocale;
  return { locale, messages: await loadMessages(locale) };
});
