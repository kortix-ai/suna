import type { Locale } from './config';

/**
 * Public URL of a full locale catalog: `/i18n/<locale>.<content-hash>.json`,
 * written to public/ at build by scripts/i18n-public-catalogs.mjs, and cached
 * immutably (next.config.ts headers).
 */
export const CATALOG_PATH_PREFIX = '/i18n/';

function versions(): Partial<Record<string, string>> {
  try {
    return JSON.parse(process.env.NEXT_PUBLIC_KORTIX_I18N_VERSIONS ?? '{}') as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

const VERSIONS = versions();

export function catalogHref(locale: Locale): string {
  const version = VERSIONS[locale];
  return `${CATALOG_PATH_PREFIX}${locale}${version ? `.${version}` : ''}.json`;
}
