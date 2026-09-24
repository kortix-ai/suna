import { beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { configureKortix } from '../core/http/config';
import { resetPreviewConfigCache } from '../core/session/preview-config';
import { useAuthenticatedPreviewUrl } from './use-authenticated-preview-url';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The preview frame gets the one-shot `?token` only for an origin the
// deployment itself advertises (`GET /v1/p/config`). A host that merely has
// the preview label shape is rendered bare.

let requested: string[] = [];

beforeEach(() => {
  requested = [];
  resetPreviewConfigCache();
  configureKortix({ backendUrl: 'https://dev-api.kortix.com/v1', getToken: async () => 'jwt-token' });
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    if (url.endsWith('/p/config')) {
      return Response.json({ preview_url_template: 'https://dev-p{port}-{sandbox}.p.kortix.com' });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
});

async function render(previewUrl: string): Promise<string | null> {
  let value: string | null = null;
  function Probe() {
    value = useAuthenticatedPreviewUrl(previewUrl);
    return null;
  }
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(Probe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => root!.unmount());
  return value;
}

test('an advertised preview origin gets the one-shot token', async () => {
  expect(await render('https://dev-p3000-sbx-a1.p.kortix.com/')).toBe(
    'https://dev-p3000-sbx-a1.p.kortix.com/?token=jwt-token',
  );
});

test('a preview-shaped host the deployment does not serve is rendered without the token', async () => {
  const appHost = 'https://dev-p3000-x-0123456789abcdef.apps.kortix.com/';
  expect(await render(appHost)).toBe(appHost);

  const foreign = 'https://p80-anything.attacker.example/';
  expect(await render(foreign)).toBe(foreign);
  // Nothing was sent to either host.
  expect(requested.some((url) => url.includes('apps.kortix.com') || url.includes('attacker.example'))).toBe(false);
});
