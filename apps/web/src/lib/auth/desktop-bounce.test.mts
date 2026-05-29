import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesktopBounceHtml,
  buildDesktopDeepLink,
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
