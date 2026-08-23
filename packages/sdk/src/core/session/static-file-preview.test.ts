import { describe, expect, it } from 'bun:test';
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
// a DIFFERENT file the authenticated URL still points at the previous one.
// Framing it shows the file the user just navigated away from — briefly, which
// reads as the preview rendering the wrong page.

describe('authenticatedUrlAddresses', () => {
  const FILE = 'https://api.kortix.cloud/v1/p/sbx1/3211/open?path=/workspace/a.html';
  const OTHER = 'https://api.kortix.cloud/v1/p/sbx1/3211/open?path=/workspace/b.html';

  it('accepts the path-based form, which authenticates by cookie and is unchanged', () => {
    expect(authenticatedUrlAddresses(FILE, FILE)).toBe(true);
  });

  it('accepts the subdomain form, which carries a one-shot token', () => {
    expect(
      authenticatedUrlAddresses('http://p3211-sbx1.localhost:8008/open?path=/a.html&token=TK', 'http://p3211-sbx1.localhost:8008/open?path=/a.html'),
    ).toBe(true);
  });

  it('rejects a URL left over from the previously opened file', () => {
    expect(authenticatedUrlAddresses(OTHER, FILE)).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(authenticatedUrlAddresses(null, FILE)).toBe(false);
    expect(authenticatedUrlAddresses(FILE, undefined)).toBe(false);
  });
});
