/**
 * Extracts the `?q=` composer-prefill prompt from a workspace page URL.
 *
 * `/workspaces/start?q=<prompt>` forwards its query string onto the resolved
 * `/projects/<id>` destination unchanged (see `withCurrentQuery` in
 * `../start/page.tsx`), so this is the one place that turns that `q` param
 * into a prompt the composer can seed. Blank/whitespace-only values are
 * treated as absent so `?q=` or `?q=%20` never seeds an empty prompt.
 */
export function promptFromSearchParams(searchParams: URLSearchParams): string | null {
  const raw = searchParams.get('q');
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
