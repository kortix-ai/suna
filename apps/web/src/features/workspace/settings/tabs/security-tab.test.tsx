import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FactorRow, SecurityTabView, totpQrSrc } from './security-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<h([23])[^>]*>([^<]*)<\/h\1>/g)].map((m) => m[2]);

const html = () => renderToStaticMarkup(<SecurityTabView />);

describe('SecurityTabView', () => {
  test('renders the pane heading and each section, in order', () => {
    expect(headings(html())).toEqual(['Security', 'Two-factor authentication', 'Devices']);
  });

  test('renders every setting row, in order', () => {
    const out = html();
    const rows = ['Authenticator app', 'Sign out other devices'];
    const positions = rows.map((label) => out.indexOf(`>${label}<`));
    expect(positions.some((p) => p < 0)).toBe(false);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('consecutive rows share one bordered group', () => {
    expect(html()).toContain('data-slot="settings-row-group"');
  });

  test('renders no password-change control — no password surface exists', () => {
    expect(html().toLowerCase()).not.toContain('password');
  });
});

/**
 * `factorsError` (fed by `useMfa()`'s `factorsQuery.isError`) must render a
 * real error state with a retry action instead of falling through to the
 * "No second factor enrolled" empty-state copy — that copy is a factual
 * claim that the factor list came back empty, not that it failed to load.
 */
describe('SecurityTabView — two-factor error state', () => {
  test('a failed factors fetch shows an error, not the empty-state banner', () => {
    const out = renderToStaticMarkup(<SecurityTabView factorsError />);
    expect(out).toContain('load your authenticator apps');
    expect(out).toContain('>Retry<');
    expect(out).not.toContain('No second factor enrolled');
  });

  test('loading takes priority over the error state', () => {
    const out = renderToStaticMarkup(<SecurityTabView factorsLoading factorsError />);
    expect(out).not.toContain('load your authenticator apps');
  });

  test('no error by default — the empty-state banner renders instead', () => {
    expect(html()).toContain('No second factor enrolled');
  });
});

/**
 * The other two answers the factor list can give. Loading is a shape-matched
 * skeleton, not a blank gap; a populated list is its own answer, so neither
 * banner may appear next to it.
 */
describe('SecurityTabView — two-factor list states', () => {
  test('an in-flight factor list shows a skeleton, not a blank gap', () => {
    const out = renderToStaticMarkup(<SecurityTabView factorsLoading />);
    expect(out).toContain('animate-pulse');
    expect(out).not.toContain('No second factor enrolled');
  });

  test('an enrolled factor renders as a row, with neither banner', () => {
    const out = renderToStaticMarkup(
      <SecurityTabView
        factors={[{ id: 'f1', friendly_name: 'My phone', factor_type: 'totp', status: 'verified' }]}
      />,
    );
    expect(out).toContain('My phone');
    expect(out).not.toContain('No second factor enrolled');
    expect(out).not.toContain('load your authenticator apps');
  });
});

describe('totpQrSrc', () => {
  test('passes a data URL through untouched', () => {
    const url = 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E';
    expect(totpQrSrc(url)).toBe(url);
  });

  test('wraps raw SVG into an encoded data URL', () => {
    const out = totpQrSrc('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(out.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(out).toContain('%3Csvg');
  });
});

describe('FactorRow', () => {
  test('verified authenticator renders name, type, and verified badge', () => {
    const factorHtml = renderToStaticMarkup(
      <FactorRow
        factor={{ id: 'f1', friendly_name: 'My phone', factor_type: 'totp', status: 'verified' }}
        onRemove={() => {}}
      />,
    );
    expect(factorHtml).toContain('My phone');
    expect(factorHtml).toContain('verified');
    expect(factorHtml).toContain('Remove factor');
  });

  test('unnamed totp factor falls back to "Authenticator app"', () => {
    const factorHtml = renderToStaticMarkup(
      <FactorRow
        factor={{ id: 'f2', factor_type: 'totp', status: 'unverified' }}
        onRemove={() => {}}
      />,
    );
    expect(factorHtml).toContain('Authenticator app');
    expect(factorHtml).toContain('unverified');
  });
});
