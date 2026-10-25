/**
 * Build the upstream path from a Next.js catch-all route's segments — safely.
 *
 * Next decodes each `[...path]` segment before handing it over, so a request for
 *
 *     /api/kortix/projects/<mine>%2F..%2F<victim>%2Fsecrets
 *
 * arrives as the SINGLE segment `projects`, `<mine>/../<victim>/secrets`. Naively
 * `path.join('/')`-ing that produces
 *
 *     projects/<mine>/../<victim>/secrets
 *
 * which `evaluatePolicy` happily matches as "a route under project <mine>" — the
 * caller owns that one, so the ownership gate passes — and which the upstream
 * then NORMALISES into `projects/<victim>/secrets`. The policy and the request
 * disagreed about which project was being addressed, and the gap is another
 * tenant's secrets.
 *
 * This was a live, confirmed hole: an authenticated user could read another
 * user's project secrets, reach `/v1/accounts/me` (which the policy blocks
 * outright), list the victim's sessions, and create a session in the victim's
 * project — the last two also skipping the server-side `end_user_ref` stamping,
 * because those code paths key on the *unnormalised* path.
 *
 * Note `..` with REAL slashes was already safe: the browser and Next normalise
 * it before routing, so it 403s. Only the percent-encoded form survived to here.
 *
 * The rule is therefore: a decoded segment must be a single, literal path
 * segment. Anything else is refused rather than sanitised — silently rewriting
 * a hostile path hides the attempt, and there is no legitimate caller that needs
 * an encoded slash inside a Kortix API path.
 */

export type UpstreamPathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The upstream base every server route forwards to — ONE documented env chain.
 *
 * Six routes each carried their own copy of this function and the chains
 * drifted apart; two of the drifts were live 404 incidents:
 *
 * - `session-model` read only `KORTIX_API_URL`, so on any deployment that
 *   configured the documented variable every model change went to the PUBLIC
 *   api and 404'd.
 * - `connections` read only the public origin too, and swallowed the failure
 *   as "no connectors" — an empty picker with no error anywhere.
 *
 * `KORTIX_UPSTREAM` (`.env.example`, wrapper mode) is always first.
 * `NEXT_PUBLIC_KORTIX_API_URL` is the documented DIRECT-mode origin and is the
 * second fallback so the one server route that also serves direct mode
 * (`/api/preview-url`) reaches the same origin the browser was given.
 * `KORTIX_API_URL` is documented nowhere and is deliberately not honored: a
 * chain that reads it silently bypasses the documented setup.
 */
export function upstreamBase(): string {
  return (
    process.env.KORTIX_UPSTREAM ??
    process.env.NEXT_PUBLIC_KORTIX_API_URL ??
    'https://api.kortix.com/v1'
  ).replace(/\/+$/, '');
}

/** Rejected outright: a decoded segment that is not one literal path segment. */
function segmentProblem(segment: string): string | null {
  if (segment === '') return 'empty path segment';
  // The traversal itself, and the encoded-slash that smuggles it in.
  if (segment.includes('/') || segment.includes('\\')) {
    return 'encoded slash in a path segment';
  }
  if (segment === '.' || segment === '..') return 'path traversal segment';
  // The upstream URL is this string, unencoded. A decoded `?` or `#` would end
  // the path there, and a decoded `%` lets `%2e%2e` reach the URL parser, which
  // resolves it as `..`. Either way the upstream path differs from the policy's.
  if (/[?#%]/.test(segment)) return 'reserved character in a path segment';
  // A NUL or control byte can truncate or confuse a downstream parser; no Kortix
  // route contains one.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  if (/[\u0000-\u001f\u007f]/.test(segment)) return 'control character in a path segment';
  return null;
}

/**
 * Join catch-all segments into an upstream path, refusing anything that would
 * let the string the POLICY sees differ from the string the UPSTREAM resolves.
 */
export function buildUpstreamPath(segments: string[]): UpstreamPathResult {
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) return { ok: false, reason: problem };
  }
  const path = segments.join('/');
  // Belt and braces: even if a future Next version changes decoding behaviour,
  // a `..` must never reach the upstream URL.
  if (path.split('/').some((s) => s === '.' || s === '..')) {
    return { ok: false, reason: 'path traversal segment' };
  }
  return { ok: true, path };
}
