import { describe, expect, it } from 'bun:test';
import { appendPreviewToken } from './preview';
import {
  STATIC_FILE_HEALTH_MAX_ATTEMPTS,
  authenticatedUrlAddresses,
  shouldRetryStaticFileHealth,
  staticFilePreviewTargets,
} from './static-file-preview';

const DEPLOYED = {
  sandboxId: 'sbx1',
  backendPort: 8008,
  apiBaseUrl: 'https://api.kortix.cloud/v1',
};

const LOCAL = {
  sandboxId: 'sbx1',
  backendPort: 8008,
  apiBaseUrl: 'http://localhost:8008/v1',
};

const UNBOUND = { ...LOCAL, sandboxId: '' };

describe('staticFilePreviewTargets', () => {
  it('pairs the file route with the health route on the same service', () => {
    // One call site, one pair. The two used to be built independently, which is
    // how a preview could poll one origin and frame another.
    expect(staticFilePreviewTargets('/workspace/index.html', DEPLOYED)).toEqual({
      previewUrl: 'https://api.kortix.cloud/v1/p/sbx1/3211/open?path=/workspace/index.html',
      healthUrl: 'https://api.kortix.cloud/v1/p/sbx1/3211/health',
    });
  });

  it('builds the subdomain form when the backend is on the user machine', () => {
    expect(staticFilePreviewTargets('/workspace/a b.html', LOCAL)).toEqual({
      previewUrl: 'http://p3211-sbx1.localhost:8008/open?path=/workspace/a%20b.html',
      healthUrl: 'http://p3211-sbx1.localhost:8008/health',
    });
  });

  it('accepts a workspace-relative path, the form a file tree hands over', () => {
    expect(staticFilePreviewTargets('reports/q1.html', DEPLOYED)?.previewUrl).toBe(
      'https://api.kortix.cloud/v1/p/sbx1/3211/open?path=/workspace/reports/q1.html',
    );
  });

  // ── The guard this function exists for. ────────────────────────────────────
  // With no sandbox bound, `buildStaticFilePreviewUrl` falls back to
  // `http://localhost:3211/...` — which is the VIEWER's own machine, not the
  // sandbox. Framing it loads whatever the user happens to be running; probing
  // it can answer 200 and declare a preview "ready" that can never load.
  it('addresses nothing until a sandbox is bound', () => {
    expect(staticFilePreviewTargets('/workspace/index.html', UNBOUND)).toBeNull();
  });

  it('addresses nothing without a path', () => {
    expect(staticFilePreviewTargets(undefined, DEPLOYED)).toBeNull();
    expect(staticFilePreviewTargets('', DEPLOYED)).toBeNull();
  });
});

describe('shouldRetryStaticFileHealth', () => {
  it('keeps probing up to the bound, then gives up', () => {
    expect(shouldRetryStaticFileHealth(1)).toBe(true);
    expect(shouldRetryStaticFileHealth(STATIC_FILE_HEALTH_MAX_ATTEMPTS - 1)).toBe(true);
    expect(shouldRetryStaticFileHealth(STATIC_FILE_HEALTH_MAX_ATTEMPTS)).toBe(false);
    expect(shouldRetryStaticFileHealth(STATIC_FILE_HEALTH_MAX_ATTEMPTS + 1)).toBe(false);
  });

  it('bounds the wait to roughly half a minute, not forever', () => {
    // A surface that polls without a bound spins "Starting preview server…"
    // silently for the life of the tab. The bound is what turns that into a
    // recoverable state with a Retry.
    expect(STATIC_FILE_HEALTH_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(STATIC_FILE_HEALTH_MAX_ATTEMPTS).toBeLessThanOrEqual(40);
  });
});

// ── Which file is the authenticated URL actually for? ──────────────────────
// Authentication resolves in an effect, so on the frame where the viewer opens
// a DIFFERENT file the authenticated URL still names the previous one. Framing
// it shows the file the user just navigated away from.
//
// Every case below runs the REAL `appendPreviewToken`, never a hand-written
// approximation of it. A prefix test passed against a concatenated string and
// shipped a preview that spun "Starting preview server…" forever: the static
// file URL is the one preview URL carrying a query (`?path=…`), and
// `appendPreviewToken` re-serializes the query through `URLSearchParams`, so
// its slashes come back as `%2F` and no prefix of the original survives.

describe('authenticatedUrlAddresses', () => {
  const SUBDOMAIN = staticFilePreviewTargets('/workspace/index.html', LOCAL)!.previewUrl;
  const DEPLOYED_FILE = staticFilePreviewTargets('/workspace/index.html', DEPLOYED)!.previewUrl;
  const DEPLOYED_OTHER = staticFilePreviewTargets('/workspace/other.html', DEPLOYED)!.previewUrl;

  it('accepts the token form the subdomain proxy actually receives', () => {
    const authenticated = appendPreviewToken(SUBDOMAIN, 'TK');
    // The proof the old prefix test was wrong, kept as a standing assertion so
    // nobody reintroduces one.
    expect(authenticated.startsWith(SUBDOMAIN)).toBe(false);
    expect(authenticated).toContain('%2Fworkspace%2Findex.html');
    expect(authenticatedUrlAddresses(authenticated, SUBDOMAIN)).toBe(true);
  });

  it('accepts the path-based form, which authenticates by cookie and is unchanged', () => {
    expect(authenticatedUrlAddresses(DEPLOYED_FILE, DEPLOYED_FILE)).toBe(true);
  });

  it('rejects a URL left over from the previously opened file', () => {
    expect(authenticatedUrlAddresses(DEPLOYED_OTHER, DEPLOYED_FILE)).toBe(false);
    expect(
      authenticatedUrlAddresses(
        appendPreviewToken(staticFilePreviewTargets('/workspace/other.html', LOCAL)!.previewUrl, 'TK'),
        SUBDOMAIN,
      ),
    ).toBe(false);
  });

  it('is not fooled by a file whose name merely extends another', () => {
    const shorter = staticFilePreviewTargets('/workspace/a.html', DEPLOYED)!.previewUrl;
    const longer = staticFilePreviewTargets('/workspace/a.html.bak', DEPLOYED)!.previewUrl;
    expect(authenticatedUrlAddresses(longer, shorter)).toBe(false);
  });

  it('rejects nothing at all, and anything unparseable', () => {
    expect(authenticatedUrlAddresses(null, DEPLOYED_FILE)).toBe(false);
    expect(authenticatedUrlAddresses(DEPLOYED_FILE, undefined)).toBe(false);
    expect(authenticatedUrlAddresses('not a url', DEPLOYED_FILE)).toBe(false);
  });
});
