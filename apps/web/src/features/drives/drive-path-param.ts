/**
 * The folder in view, as Drive's `?path=` query value. Short and readable,
 * and it reverses with no lookup: the caller's own folder (`/Users/<name>`)
 * is `~`, so `/Users/ana/Memory/2026` is `~/Memory/2026`; any other folder is
 * its drive path without the leading slash; the top of Drive is no value.
 *
 * Paths here are the explorer store's form: `/` for the top, else no leading
 * slash (`Users/ana/Memory`). `personal` is `Drive.personalFolder`.
 */
export function drivePathToParam(path: string, personal: string | null): string {
  const abs = `/${path.replace(/^\/+|\/+$/g, '')}`;
  if (abs === '/') return '';
  if (personal && (abs === personal || abs.startsWith(`${personal}/`))) {
    return `~${abs.slice(personal.length)}`;
  }
  return abs.slice(1);
}

export function drivePathFromParam(param: string | null, personal: string | null): string {
  const value = (param ?? '').trim();
  if (!value) return '/';
  // Only `~` or `~/…`: a top-level folder may itself be named `~notes`.
  const abs = value === '~' || value.startsWith('~/')
    ? personal
      ? `${personal}${value.slice(1)}`
      : '/'
    : `/${value.replace(/^\/+/, '')}`;
  return abs.replace(/^\/+|\/+$/g, '') || '/';
}

/** `?path=` with its slashes left readable; other query values are kept. */
export function driveUrlWithPath(href: string, param: string): string {
  const url = new URL(href);
  if (param) url.searchParams.set('path', param);
  else url.searchParams.delete('path');
  return `${url.pathname}${url.search.replace(/%2F/gi, '/').replace(/%7E/gi, '~')}${url.hash}`;
}
