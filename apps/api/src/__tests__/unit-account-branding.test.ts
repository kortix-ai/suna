// Organization branding — the pure halves of accounts/branding.ts.
//
// The route handlers are exercised black-box by the ACCT-BRAND-* REST flows
// (tests/src/flows/accounts.flow.ts). What is pinned here is everything a
// handler decides WITHOUT the network: which bytes count as an image (and
// which SVGs are refused), how the stored jsonb normalizes to the wire shape,
// when serving falls back to Kortix, the content-addressed object name, and
// the product-name rules.
import { describe, expect, test } from 'bun:test';
import {
  brandingObjectPath,
  brandingObjectPathFromUrl,
  effectiveBranding,
  isBrandingEmpty,
  normalizeAppName,
  normalizeBranding,
  sniffBrandingImage,
} from '../accounts/branding';

// The entitlement read is injected (no `mock.module` — bun shares module mocks
// across every file in one run, and a mocked entitlements module would poison
// the billing suites that run beside this one).
let entitled = true;
const check = async () => entitled;

const enc = (s: string) => new TextEncoder().encode(s);

describe('sniffBrandingImage — bytes decide, never the declared type', () => {
  test('PNG / JPEG / WebP / ICO by magic number', () => {
    expect(sniffBrandingImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toEqual({
      contentType: 'image/png',
      ext: 'png',
    });
    expect(sniffBrandingImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      contentType: 'image/jpeg',
      ext: 'jpg',
    });
    const webp = new Uint8Array(16);
    webp.set(enc('RIFF'), 0);
    webp.set(enc('WEBP'), 8);
    expect(sniffBrandingImage(webp)).toEqual({ contentType: 'image/webp', ext: 'webp' });
    expect(sniffBrandingImage(new Uint8Array([0, 0, 1, 0, 1, 0]))).toEqual({
      contentType: 'image/x-icon',
      ext: 'ico',
    });
  });

  test('SVG: plain root, XML prolog, BOM, and a leading comment all pass', () => {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
      '\uFEFF<svg/>',
      '<!-- logo --><svg viewBox="0 0 1 1"/>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg/>',
    ]) {
      expect(sniffBrandingImage(enc(svg))).toEqual({ contentType: 'image/svg+xml', ext: 'svg' });
    }
  });

  test('SVG carrying script, event handlers, or javascript: URLs is refused', () => {
    for (const svg of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"/>',
      '<svg><a href="javascript:alert(1)"/></svg>',
    ]) {
      expect(sniffBrandingImage(enc(svg))).toBeNull();
    }
  });

  test('anything else is refused — HTML, text, a GIF, an empty body', () => {
    expect(sniffBrandingImage(enc('<html><body>hi</body></html>'))).toBeNull();
    expect(sniffBrandingImage(enc('hello'))).toBeNull();
    expect(sniffBrandingImage(enc('GIF89a....'))).toBeNull();
    expect(sniffBrandingImage(new Uint8Array(0))).toBeNull();
  });
});

describe('normalizeBranding / isBrandingEmpty', () => {
  test('fills every slot with null and drops empty strings', () => {
    expect(normalizeBranding(undefined)).toEqual({
      app_name: null,
      logo_url: null,
      icon_url: null,
      favicon_url: null,
      logo_dark_url: null,
      icon_dark_url: null,
      favicon_dark_url: null,
    });
    expect(normalizeBranding({ app_name: '', logo_url: 'http://x/l.svg' })).toEqual({
      app_name: null,
      logo_url: 'http://x/l.svg',
      icon_url: null,
      favicon_url: null,
      logo_dark_url: null,
      icon_dark_url: null,
      favicon_dark_url: null,
    });
  });

  test('empty means every slot null', () => {
    expect(isBrandingEmpty(normalizeBranding({}))).toBe(true);
    expect(isBrandingEmpty(normalizeBranding({ icon_dark_url: 'http://x/i.png' }))).toBe(false);
  });
});

describe('effectiveBranding — what members are SERVED', () => {
  test('nothing stored → null, without touching billing', async () => {
    entitled = false;
    expect(await effectiveBranding('acc', {}, check)).toBeNull();
    expect(await effectiveBranding('acc', null, check)).toBeNull();
  });

  test('stored + entitled → the record', async () => {
    entitled = true;
    expect(await effectiveBranding('acc', { logo_url: 'http://x/l.svg' }, check)).toEqual({
      app_name: null,
      logo_url: 'http://x/l.svg',
      icon_url: null,
      favicon_url: null,
      logo_dark_url: null,
      icon_dark_url: null,
      favicon_dark_url: null,
    });
  });

  test('stored but the entitlement lapsed → null (fall back to Kortix, no write)', async () => {
    entitled = false;
    expect(await effectiveBranding('acc', { logo_url: 'http://x/l.svg' }, check)).toBeNull();
  });
});

describe('object naming', () => {
  test('content-addressed: same bytes → same path; different bytes → different path', async () => {
    expect(await brandingObjectPath('acc-1', 'logo_dark', enc('<svg/>'), 'svg')).toMatch(
      /^acc-1\/logo_dark-[0-9a-f]{12}\.svg$/,
    );
    const a = await brandingObjectPath('acc-1', 'logo', enc('<svg/>'), 'svg');
    const b = await brandingObjectPath('acc-1', 'logo', enc('<svg/>'), 'svg');
    const c = await brandingObjectPath('acc-1', 'logo', enc('<svg viewBox="0 0 1 1"/>'), 'svg');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^acc-1\/logo-[0-9a-f]{12}\.svg$/);
  });

  test('the bucket path is recovered from our own public URL, and from nothing else', () => {
    expect(
      brandingObjectPathFromUrl(
        'http://127.0.0.1:54321/storage/v1/object/public/branding/acc-1/logo-abcdef012345.svg',
      ),
    ).toBe('acc-1/logo-abcdef012345.svg');
    expect(
      brandingObjectPathFromUrl(
        'https://x.supabase.co/storage/v1/object/public/branding/acc-1/icon-1.png?v=2',
      ),
    ).toBe('acc-1/icon-1.png');
    expect(brandingObjectPathFromUrl('https://evil.example/logo.svg')).toBeNull();
    expect(brandingObjectPathFromUrl(null)).toBeNull();
    expect(brandingObjectPathFromUrl('')).toBeNull();
  });
});

describe('normalizeAppName', () => {
  test('null / empty / whitespace clear the name', () => {
    expect(normalizeAppName(null)).toEqual({ ok: true, value: null });
    expect(normalizeAppName('')).toEqual({ ok: true, value: null });
    expect(normalizeAppName('   ')).toEqual({ ok: true, value: null });
  });

  test('collapses whitespace and trims', () => {
    expect(normalizeAppName('  Acme   Copilot ')).toEqual({ ok: true, value: 'Acme Copilot' });
  });

  test('refuses non-strings, over-long names, and control characters', () => {
    expect(normalizeAppName(42).ok).toBe(false);
    expect(normalizeAppName('x'.repeat(61)).ok).toBe(false);
    expect(normalizeAppName(`Acme${String.fromCharCode(0)}`).ok).toBe(false);
    expect(normalizeAppName('x'.repeat(60)).ok).toBe(true);
  });
});
