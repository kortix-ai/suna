import { describe, expect, test } from 'bun:test';

/**
 * Characterization of the wildcard Caddyfile site blocks, captured BEFORE the
 * KRTX-1341 dedupe that replaces the two hand-copied 21-line site bodies with
 * one shared literal.
 *
 * `renderCaddyfile` is snapshotted byte for byte for all four hosting
 * configurations (neither, apps-only, preview-only, both). After the refactor
 * the rendered bytes must be identical — that is the whole point of sharing
 * the literal instead of reformatting it.
 *
 * The hand-counted duplicate is pinned by the snapshot pair itself: the two
 * site bodies inside these goldens must keep differing ONLY in their hostname
 * and their leading comments.
 */
import { renderCaddyfile } from '../compose-assets.ts';

describe('Caddyfile wildcard blocks — exact render characterization (KRTX-1341)', () => {
  test('neither family configured renders the base Caddyfile byte for byte', () => {
    expect(renderCaddyfile()).toMatchSnapshot('neither');
  });

  test('apps-only renders base + the exact Apps wildcard block', () => {
    expect(renderCaddyfile({ appsHostingConfigured: true })).toMatchSnapshot('apps-only');
  });

  test('preview-only renders base + the exact preview wildcard block', () => {
    expect(renderCaddyfile({ previewHostingConfigured: true })).toMatchSnapshot('preview-only');
  });

  test('both configured renders base + apps block + preview block, one shared ask', () => {
    const caddyfile = renderCaddyfile({ appsHostingConfigured: true, previewHostingConfigured: true });
    expect(caddyfile).toMatchSnapshot('both');
    // Exactly one global on_demand_tls ask — Caddy refuses a second one.
    expect(caddyfile.match(/on_demand_tls \{/g)).toHaveLength(1);
  });

  test('the two site bodies stay twin shapes: same body, different hostname + comment', () => {
    const apps = renderCaddyfile({ appsHostingConfigured: true });
    const preview = renderCaddyfile({ previewHostingConfigured: true });
    const bodyOf = (text: string, marker: string) => {
      const start = text.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      // From the site address line to the file's end (each block is appended
      // last, so its body runs to the end of the rendered file).
      return text.slice(text.indexOf('\n', start) + 1);
    };
    const appsBody = bodyOf(apps, '*.{$KORTIX_APPS_BASE_DOMAIN} {');
    const previewBody = bodyOf(preview, '*.{$KORTIX_PREVIEW_BASE_DOMAIN} {');
    // Identical body, INCLUDING the trailing newline — 21 lines, byte for byte.
    expect(appsBody).toBe(previewBody);
    // The only differences live in the site address and the comment above it.
    expect(apps).toContain('*.{$KORTIX_APPS_BASE_DOMAIN} {');
    expect(preview).toContain('*.{$KORTIX_PREVIEW_BASE_DOMAIN} {');
  });
});
