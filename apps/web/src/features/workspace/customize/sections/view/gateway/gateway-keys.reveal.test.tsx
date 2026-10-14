import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { readFileSync } from '@/i18n/test-source';

import { GatewayFirstRequest, firstRequestSamples } from './gateway-api-reference';

const keys = readFileSync(join(import.meta.dir, 'gateway-keys.tsx'), 'utf8');
const reveal = keys.slice(keys.indexOf('function RevealKeyDialog'));

/** Paper KM01: the show-once reveal with one first-request card. */
describe('Gateway key reveal — KM01', () => {
  test('samples read the key from KORTIX_GATEWAY_KEY and never inline it', () => {
    const samples = firstRequestSamples('https://gateway.example.test');
    expect(samples.curl.code).toContain('Bearer $KORTIX_GATEWAY_KEY');
    expect(samples.python.code).toContain('os.environ["KORTIX_GATEWAY_KEY"]');
    expect(samples.node.code).toContain('process.env.KORTIX_GATEWAY_KEY');
    for (const sample of Object.values(samples)) {
      expect(sample.code).toContain('https://gateway.example.test/v1');
      expect(sample.code).not.toContain('kortix_gw_');
    }
  });

  test('the card: curl / Python / Node, POST endpoint, line numbers, labelled Copy', () => {
    const out = renderToStaticMarkup(<GatewayFirstRequest gatewayUrl={null} />);
    expect(out).toContain('Make your first request');
    expect(out).toContain('>curl<');
    expect(out).toContain('>Python<');
    expect(out).toContain('>Node<');
    expect(out).toContain('/v1/chat/completions');
    expect(out).toContain('Copy');
    // A gutter row per line of the curl sample.
    const curlLines = firstRequestSamples(null).curl.code.split('\n').length;
    expect(out).toContain(`<span>${curlLines}</span>`);
    // Markdown-style footnote: the env var and base URL as inline code chips.
    expect(out).toMatch(/<code[^>]*>KORTIX_GATEWAY_KEY<\/code>/);
    expect(out).toMatch(/<code[^>]*>https:\/\/gateway\.kortix\.com\/v1<\/code>/);
  });

  test('the dialog: full key + dark Copy, the shown-once note in an info Alert', () => {
    expect(reveal).toContain('{created.secret_key}');
    expect(reveal).toContain("t('shownOnceNote')");
    expect(reveal).toContain('<Alert>');
    expect(reveal).not.toContain('InfoBanner');
    expect(reveal).toContain('<GatewayFirstRequest');
  });

  test('closing is gated on "I\'ve stored this key"', () => {
    expect(reveal).toContain("t('storedConfirm')");
    expect(reveal).toContain('disabled={!stored}');
    // ×, Escape and outside click all route through onOpenChange.
    expect(reveal).toContain('!open && stored ? onClose() : undefined');
  });
});
