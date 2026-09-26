import { locales } from './config';

/**
 * `generateStaticParams` for the `[locale]` root segment. Layouts of the public
 * marketing and SEO route groups export it, so each of their pages prerenders
 * once per locale. App routes do not, so they render per request.
 */
export function localeStaticParams(): { locale: string }[] {
  return locales.map((locale) => ({ locale }));
}
