/**
 * Content-Security-Policy for every web response (see `headers()` in
 * next.config.ts).
 *
 * Two headers, on purpose:
 *
 * - `Content-Security-Policy` (enforced) holds only directives that no page
 *   needs to break: `frame-ancestors 'self'` (unchanged), `object-src 'none'`
 *   (no page embeds plugins) and `base-uri 'self'` (no page sets `<base>`).
 *
 * - `Content-Security-Policy-Report-Only` holds the `script-src` allowlist.
 *   The app renders several inline bootstrap scripts from the root layout, and
 *   GTM, Stripe, PostHog, Vercel and the visitor pixel each load scripts from
 *   their own hosts. An enforced allowlist that misses one host or inline hash
 *   breaks sign-in, checkout or the whole app, and no local check can prove it
 *   complete. Report-only collects the violations real pages produce at
 *   `/api/csp-report`; once those reports are clean for a release cycle, move
 *   `script-src` into the enforced header (with nonces for the inline scripts).
 */

export const CSP_REPORT_PATH = '/api/csp-report';

/** Hosts that legitimately serve scripts to kortix pages today. */
export const SCRIPT_SRC_HOSTS = [
  // Google Tag Manager and the tags it loads (GA4, Ads).
  'https://www.googletagmanager.com',
  'https://*.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://*.google-analytics.com',
  'https://www.googleadservices.com',
  'https://googleads.g.doubleclick.net',
  // Consent banner and Meta pixel, both loaded by GTM.
  'https://cdn-cookieyes.com',
  'https://connect.facebook.net',
  // Visitor pixel (components/analytics/visitor-pixel.tsx).
  'https://d2mvefebd70kbz.cloudfront.net',
  // Embedded checkout (app/[locale]/(app)/checkout).
  'https://js.stripe.com',
  // Vercel Analytics / Speed Insights / toolbar.
  'https://va.vercel-scripts.com',
  'https://vercel.live',
] as const;

export function enforcedContentSecurityPolicy(): string {
  return ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'"].join('; ') + ';';
}

export function reportOnlyContentSecurityPolicy(): string {
  const scriptSrc = [
    "'self'",
    // Inline bootstrap scripts in the root layout; see the file comment.
    "'unsafe-inline'",
    // Shiki's regex engine and the file viewers compile WebAssembly.
    "'wasm-unsafe-eval'",
    // Workers created from blob URLs (PDF and editor workers).
    'blob:',
    ...SCRIPT_SRC_HOSTS,
  ];
  return (
    [
      `script-src ${scriptSrc.join(' ')}`,
      "object-src 'none'",
      "base-uri 'self'",
      `report-uri ${CSP_REPORT_PATH}`,
    ].join('; ') + ';'
  );
}

/**
 * The fields worth logging from one violation report, reduced to origins and
 * paths. A report's `document-uri` is the full page URL, and on some pages its
 * query or path carries an email address or a capability token; the log keeps
 * only the page path's first segment.
 */
export function summarizeCspReport(body: unknown): {
  directive: string;
  blocked: string;
  page: string;
} | null {
  const report =
    body && typeof body === 'object' && 'csp-report' in body
      ? (body as { 'csp-report': unknown })['csp-report']
      : null;
  if (!report || typeof report !== 'object') return null;
  const field = (name: string) => {
    const value = (report as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : '';
  };
  const directive = (field('effective-directive') || field('violated-directive')).split(' ')[0]!;
  return {
    directive: directive.slice(0, 64),
    blocked: originOrKeyword(field('blocked-uri')),
    page: firstPathSegment(field('document-uri')),
  };
}

function originOrKeyword(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
  } catch {
    // `inline`, `eval`, `wasm-eval`, `blob`, …
    return value.slice(0, 32);
  }
}

function firstPathSegment(value: string): string {
  try {
    const segment = new URL(value).pathname.split('/')[1] ?? '';
    return `/${segment.slice(0, 64)}`;
  } catch {
    return '';
  }
}
