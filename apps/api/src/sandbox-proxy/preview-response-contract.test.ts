import { describe, expect, test } from 'bun:test';

// No config mock: replacing that module wholesale deletes every export the
// collaborators need. The hermetic scripts/test.env supplies the real shape.
const { portUnreachableResponse } = await import('./routes/preview');
const { PREVIEW_STATE_HEADER } = await import('./preview-state-page');

const BROWSER = new Headers({ accept: 'text/html', host: 'dev-p8081-sbx-a.p.kortix.com' });
const MACHINE = new Headers({ accept: 'application/json', host: 'dev-p8081-sbx-a.p.kortix.com' });

/**
 * The design's load-bearing invariant, asserted on real Responses: a browser is
 * never handed a 5xx for a transient state (an intermediary replaces it), while
 * a machine's view of the truth is unchanged. Nothing asserted this before —
 * the page renderer was tested as a string, and the response builder only for
 * hop attribution.
 */
describe('what each caller is told about an unreachable port', () => {
  const cases = [
    { name: 'sandbox waking', opts: { code: 'sandbox_not_ready', retry: true, upstreamStatus: null }, state: 'starting', status: 503 },
    { name: 'nothing listening', opts: { upstreamStatus: null }, state: 'not-listening', status: 502 },
    { name: 'app answered an error', opts: { upstreamStatus: 503 }, state: 'unreachable', status: 502 },
  ] as const;

  for (const c of cases) {
    test(`${c.name}: a browser gets 200 and a page`, async () => {
      const res = portUnreachableResponse({
        port: 8081,
        status: c.status,
        origin: '',
        incomingHeaders: BROWSER,
        reason: 'x',
        hop: 'upstream_port',
        ...c.opts,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get(PREVIEW_STATE_HEADER)).toBe(c.state);
      // The truth is still fully legible to a probe reading the HTML response.
      expect(res.headers.get('x-kortix-proxy-hop')).toBe('upstream_port');
      expect(await res.text()).toContain('<!doctype html>');
    });

    test(`${c.name}: a machine gets the real status and JSON`, async () => {
      const res = portUnreachableResponse({
        port: 8081,
        status: c.status,
        origin: '',
        incomingHeaders: MACHINE,
        reason: 'x',
        hop: 'upstream_port',
        ...c.opts,
      });
      expect(res.status).toBe(c.status);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-kortix-proxy-hop')).toBe('upstream_port');
    });
  }

  test('the web app CAN read the hop headers cross-origin', () => {
    const res = portUnreachableResponse({
      port: 8081,
      status: 502,
      origin: 'http://localhost:3000',
      incomingHeaders: MACHINE,
      reason: 'x',
      hop: 'upstream_port',
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Kortix-Proxy-Hop');
  });

  test('an unknown origin gets no credentialed CORS grant on either branch', () => {
    for (const headers of [BROWSER, MACHINE]) {
      const res = portUnreachableResponse({
        port: 8081,
        status: 502,
        origin: 'https://evil.example',
        incomingHeaders: headers,
        reason: 'x',
        hop: 'upstream_port',
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});
