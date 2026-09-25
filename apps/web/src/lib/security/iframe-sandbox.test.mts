import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAgentContentIframeSandbox,
  getIframeSandbox,
  INTERACTIVE_PREVIEW_IFRAME_SANDBOX,
  ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX,
} from './iframe-sandbox.ts';

function tokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

test('interactive preview sandbox keeps same-origin for app previews', () => {
  const sandboxTokens = tokens(INTERACTIVE_PREVIEW_IFRAME_SANDBOX);

  assert.ok(sandboxTokens.includes('allow-same-origin'));
  assert.ok(sandboxTokens.includes('allow-scripts'));
  assert.ok(sandboxTokens.includes('allow-modals'));
});

test('isolated HTML preview sandbox removes same-origin', () => {
  const sandboxTokens = tokens(ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX);

  assert.ok(!sandboxTokens.includes('allow-same-origin'));
  assert.ok(sandboxTokens.includes('allow-scripts'));
  assert.ok(sandboxTokens.includes('allow-downloads'));
});

test('getIframeSandbox returns isolated mode only when requested', () => {
  assert.equal(getIframeSandbox(), INTERACTIVE_PREVIEW_IFRAME_SANDBOX);
  assert.equal(
    getIframeSandbox({ isolateHtmlPreview: true }),
    ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX,
  );
});

// Agent-authored HTML (the `show` card, deck slides) keeps `allow-same-origin`
// only on an origin of its own. Served from this app or the API (the path
// proxy `/v1/p/<sandbox>/<port>/…`), it runs with an opaque origin like
// HtmlPreview, so it cannot use the viewer's cookies for that origin.
const APP = 'https://app.example.com';
const API = 'https://api.example.com/v1';
const PRIVILEGED = [APP, API];

test('agent content on a per-sandbox preview origin keeps same-origin', () => {
  const sandboxTokens = tokens(
    getAgentContentIframeSandbox('https://3211--sbx1.preview.example.com/report.html', {
      privilegedOrigins: PRIVILEGED,
    }),
  );

  assert.ok(sandboxTokens.includes('allow-same-origin'));
  assert.ok(sandboxTokens.includes('allow-scripts'));
});

test('agent content served through the API path proxy loses same-origin', () => {
  const sandboxTokens = tokens(
    getAgentContentIframeSandbox('https://api.example.com/v1/p/sbx1/3211/report.html', {
      privilegedOrigins: PRIVILEGED,
    }),
  );

  assert.ok(!sandboxTokens.includes('allow-same-origin'));
  assert.ok(sandboxTokens.includes('allow-scripts'));
  assert.ok(sandboxTokens.includes('allow-forms'));
});

test('agent content on the app origin, or relative to it, loses same-origin', () => {
  for (const src of [`${APP}/share/x.html`, '/v1/p/sbx1/3211/report.html']) {
    const sandboxTokens = tokens(
      getAgentContentIframeSandbox(src, { privilegedOrigins: PRIVILEGED, baseUrl: APP }),
    );
    assert.ok(!sandboxTokens.includes('allow-same-origin'), src);
  }
});

test('an unparseable frame URL fails closed', () => {
  const sandboxTokens = tokens(
    getAgentContentIframeSandbox('http://:', { privilegedOrigins: PRIVILEGED }),
  );

  assert.ok(!sandboxTokens.includes('allow-same-origin'));
});

test('presentation frames keep modals and drop same-origin on a privileged origin', () => {
  const onProxy = tokens(
    getAgentContentIframeSandbox('https://api.example.com/v1/p/sbx1/3211/slide_01.html', {
      privilegedOrigins: PRIVILEGED,
      presentation: true,
    }),
  );
  const onPreview = tokens(
    getAgentContentIframeSandbox('https://3211--sbx1.preview.example.com/slide_01.html', {
      privilegedOrigins: PRIVILEGED,
      presentation: true,
    }),
  );

  assert.deepEqual(onProxy.sort(), ['allow-modals', 'allow-scripts']);
  assert.deepEqual(onPreview.sort(), ['allow-modals', 'allow-same-origin', 'allow-scripts']);
});
