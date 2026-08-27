import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDesktopBounceHtml,
  buildDesktopDeepLink,
  buildMobileBounceHtml,
  buildMobileDeepLink,
  escapeHtmlAttribute,
  serializeForInlineScript,
} from './desktop-bounce.ts';

const U2028 = String.fromCharCode(0x2028);
const U2029 = String.fromCharCode(0x2029);

// ── serializeForInlineScript: the core defense-in-depth guarantee ──────────
// This must hold even for RAW dangerous input, independent of any URL-encoding
// upstream — a future refactor could feed it an unencoded value.

test('serializeForInlineScript escapes a literal </script> so it cannot break out', () => {
  const out = serializeForInlineScript('a</script><script>alert(1)</script>b');
  assert.ok(!out.includes('</script>'), 'must not contain a literal </script>');
  assert.ok(!out.includes('<'), 'no raw <');
  assert.ok(!out.includes('>'), 'no raw >');
  assert.ok(out.includes('\\u003C'), 'escapes < as \\u003C');
});

test('serializeForInlineScript escapes & and the U+2028/U+2029 line separators', () => {
  const raw = `&${U2028}${U2029}`;
  const out = serializeForInlineScript(raw);
  assert.ok(!out.includes('&'), 'no raw &');
  assert.ok(!out.includes(U2028), 'no raw U+2028');
  assert.ok(!out.includes(U2029), 'no raw U+2029');
  assert.ok(out.includes('\\u0026') && out.includes('\\u2028') && out.includes('\\u2029'));
});

test('serializeForInlineScript output is still valid JSON that round-trips', () => {
  const raw = 'kortix://auth/callback?x=</script>&y= z';
  assert.equal(JSON.parse(serializeForInlineScript(raw)), raw);
});

// ── escapeHtmlAttribute ────────────────────────────────────────────────────

test('escapeHtmlAttribute escapes all attribute-significant characters', () => {
  assert.equal(
    escapeHtmlAttribute(`<a href="x" b='y' & z>`),
    '&lt;a href=&quot;x&quot; b=&#39;y&#39; &amp; z&gt;',
  );
});

// ── buildDesktopDeepLink ───────────────────────────────────────────────────

test('buildDesktopDeepLink drops the desktop flag and re-encodes values', () => {
  const sp = new URLSearchParams();
  sp.set('desktop', 'true');
  sp.set('code', 'a b');
  sp.set('x', '</script>');
  const link = buildDesktopDeepLink(sp);
  assert.ok(link.startsWith('kortix://auth/callback?'));
  assert.ok(!link.includes('desktop='), 'desktop flag is not forwarded');
  assert.ok(!link.includes('<'), 'values are percent-encoded');
  assert.ok(link.includes('code=a+b'));
});

test('buildDesktopDeepLink with no params yields a bare deep link', () => {
  assert.equal(buildDesktopDeepLink(new URLSearchParams()), 'kortix://auth/callback');
});

// ── mobile handoff ─────────────────────────────────────────────────────────

test('buildMobileDeepLink keeps the auth code, state, and registration marker', () => {
  const sp = new URLSearchParams();
  sp.set('mobile_callback', '1');
  sp.set('code', 'a b');
  sp.set('state', 'native-state');
  sp.set('x', '</script>');

  const link = buildMobileDeepLink(sp);

  assert.equal(
    link,
    'kortix://auth/callback?mobile_callback=1&code=a+b&state=native-state&x=%3C%2Fscript%3E',
  );
});

test('buildMobileBounceHtml keeps a state-validated callback safe without an automatic custom-scheme redirect', () => {
  const sp = new URLSearchParams();
  sp.set('mobile_callback', '1');
  sp.set('code', 'abc123');
  sp.set('state', 'native-state');
  sp.set('x', '</script><script>alert(1)</script>');

  const html = buildMobileBounceHtml(sp);

  assert.equal((html.match(/<script/gi) ?? []).length, 0);
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 0);
  assert.ok(
    html.includes(
      'kortix://auth/callback?mobile_callback=1&amp;code=abc123&amp;state=native-state',
    ),
  );
  assert.ok(html.includes('Open Kortix'));
});

// ── buildDesktopBounceHtml: end-to-end, with a malicious payload ────────────

test('buildDesktopBounceHtml does not allow a script breakout from query params', () => {
  const sp = new URLSearchParams();
  sp.set('desktop', 'true');
  sp.set('code', 'good-code');
  // Attacker tries every classic break-out shape:
  sp.set('x', '</script><script>alert(document.domain)</script>');
  sp.set('y', '"></a><img src=x onerror=alert(1)>');
  const html = buildDesktopBounceHtml(sp);

  // Exactly one opening and one closing <script> — the legitimate bounce script.
  assert.equal((html.match(/<script/gi) ?? []).length, 1, 'no injected <script');
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 1, 'no injected </script>');
  // No injected <img> / onerror payload survived into the markup.
  assert.ok(!/onerror=/i.test(html), 'no onerror handler injected');
  // The desktop flag is never echoed back.
  assert.ok(!html.includes('desktop=true'));
  // The legitimate deep link is still present.
  assert.ok(html.includes('kortix://auth/callback'));
});

test('buildDesktopBounceHtml renders a normal deep link cleanly', () => {
  const sp = new URLSearchParams();
  sp.set('desktop', 'true');
  sp.set('code', 'abc123');
  const html = buildDesktopBounceHtml(sp);
  assert.ok(html.includes('window.location.replace('));
  assert.ok(html.includes('kortix://auth/callback?code=abc123'));
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 1);
});

/* ── Per-channel deep-link scheme ─────────────────────────────────────────
   Three desktop builds can be installed at once, so the bounce has to name the
   scheme of the build that actually started the sign-in. */

test('desktop deep link uses the scheme the app asked for', () => {
  const params = new URLSearchParams({ code: 'abc', desktop: 'true', desktop_scheme: 'kortix-dev' });
  assert.equal(buildDesktopDeepLink(params), 'kortix-dev://auth/callback?code=abc');
});

test('desktop deep link supports staging', () => {
  const params = new URLSearchParams({ code: 'abc', desktop_scheme: 'kortix-staging' });
  assert.equal(buildDesktopDeepLink(params), 'kortix-staging://auth/callback?code=abc');
});

// Every build shipped before per-channel schemes existed sends no marker and
// answers only kortix://.
test('desktop deep link falls back to kortix:// when no scheme is sent', () => {
  const params = new URLSearchParams({ code: 'abc', desktop: 'true' });
  assert.equal(buildDesktopDeepLink(params), 'kortix://auth/callback?code=abc');
});

// The param arrives on a public callback URL. It must never dictate a protocol.
test('desktop deep link rejects an unknown scheme', () => {
  for (const raw of ['javascript', 'file', 'kortix-evil', 'https']) {
    const params = new URLSearchParams({ code: 'abc', desktop_scheme: raw });
    assert.equal(buildDesktopDeepLink(params), 'kortix://auth/callback?code=abc');
  }
});

// desktop_scheme is transport. Forwarding it into the app's /auth/callback
// would leak a build marker into the app's own query handling.
test('desktop deep link strips both transport markers', () => {
  const params = new URLSearchParams({
    code: 'abc',
    desktop: 'true',
    desktop_scheme: 'kortix-dev',
    returnUrl: '/projects',
  });
  const link = new URL(buildDesktopDeepLink(params));
  assert.equal(link.searchParams.get('desktop'), null);
  assert.equal(link.searchParams.get('desktop_scheme'), null);
  assert.equal(link.searchParams.get('code'), 'abc');
  assert.equal(link.searchParams.get('returnUrl'), '/projects');
});

// The mobile app ships a single build; its scheme must not move.
test('mobile deep link stays on kortix:// and keeps its marker', () => {
  const params = new URLSearchParams({ mobile_callback: '1', state: 's', code: 'abc' });
  const link = buildMobileDeepLink(params);
  assert.ok(link.startsWith('kortix://auth/callback?'));
  assert.ok(link.includes('mobile_callback=1'));
});

test('bounce HTML carries the channel scheme into both sinks', () => {
  const html = buildDesktopBounceHtml(
    new URLSearchParams({ code: 'abc123', desktop_scheme: 'kortix-dev' }),
  );
  // href attribute and the inline <script> redirect.
  assert.ok(html.includes('href="kortix-dev://auth/callback?code=abc123"'));
  assert.ok(html.includes('window.location.replace("kortix-dev://auth/callback?code=abc123")'));
  assert.ok(!html.includes('"kortix://'));
});
