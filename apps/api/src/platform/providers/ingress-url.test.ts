import { describe, expect, test } from 'bun:test';
import { ingressTargetUrl } from './ingress-url';

const edge = 'https://5173-01kzp370wdb8.eu-west.sbx.platinum.dev';

describe('ingressTargetUrl', () => {
  test('joins the ingress origin with the client path and query unchanged', () => {
    expect(ingressTargetUrl({ url: `${edge}/` }, '/src/main.ts?import&v=2')).toBe(
      `${edge}/src/main.ts?import&v=2`,
    );
  });

  test('keeps the token out of the URL when the client query has no conflicting name', () => {
    const ingress = { url: edge, queryToken: { name: 't', value: 'tok.sig' } };
    expect(ingressTargetUrl(ingress, '/index.html')).toBe(`${edge}/index.html`);
    expect(ingressTargetUrl(ingress, '/a?x=1')).toBe(`${edge}/a?x=1`);
  });

  // Vite requests hot-updated modules as `/src/App.tsx?t=<timestamp>`. The
  // Platinum edge reads the FIRST `t` as its credential and strips every `t`
  // before forwarding, so the provider token must come first.
  test('puts the provider token first when the client query carries the same name', () => {
    const ingress = { url: edge, queryToken: { name: 't', value: 'tok.sig' } };
    const url = ingressTargetUrl(ingress, '/src/App.tsx?t=1727000000000&import');
    expect(url).toBe(`${edge}/src/App.tsx?t=tok.sig&t=1727000000000&import`);
    expect(new URL(url).searchParams.get('t')).toBe('tok.sig');
  });

  test('keeps a fragment after the query', () => {
    const ingress = { url: edge, queryToken: { name: 't', value: 'tok' } };
    expect(ingressTargetUrl(ingress, '/a?t=1#frag')).toBe(`${edge}/a?t=tok&t=1#frag`);
  });
});
