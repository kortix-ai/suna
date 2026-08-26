// Organization branding — the Enterprise `branding` entitlement.
//
// Wire contract pinned here:
//   GET    /accounts/:id/branding               → { branding, entitled }
//   POST   /accounts/:id/branding/assets/:kind  → multipart `file`, no JSON
//   DELETE /accounts/:id/branding/assets/:kind  → { branding, entitled }
//   DELETE /accounts/:id/branding               → { branding, entitled }
// and `KortixAccount.branding` on the list, which is what the web provider
// renders from (one request the app already makes — no second fetch).
import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  getAccountBranding,
  listAccounts,
  removeAccountBrandingAsset,
  resetAccountBranding,
  uploadAccountBrandingAsset,
} from './accounts';

interface Captured {
  url: string;
  method: string;
  body: unknown;
  contentType: string | null;
}

let calls: Captured[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(
    async (url: unknown, opts: { method?: string; body?: unknown; headers?: unknown } = {}) => {
      const headers = new Headers((opts.headers as HeadersInit | undefined) ?? {});
      calls.push({
        url: String(url),
        method: opts.method ?? 'GET',
        body: opts.body,
        contentType: headers.get('content-type'),
      });
      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;

const STATE = {
  branding: {
    logo_url: 'http://s/storage/v1/object/public/branding/acc-1/logo-abc.svg',
    icon_url: null,
    favicon_url: null,
    logo_dark_url: null,
    icon_dark_url: null,
    favicon_dark_url: null,
  },
  entitled: true,
};

test('getAccountBranding → GET /accounts/:id/branding, returns stored record + entitlement', async () => {
  nextResponse = { status: 200, body: STATE };
  const state = await getAccountBranding('acc-1');
  expect(last().url).toBe('http://test.local/accounts/acc-1/branding');
  expect(last().method).toBe('GET');
  expect(state.entitled).toBe(true);
  expect(state.branding.logo_url).toContain('/branding/acc-1/logo-abc.svg');
  expect(state.branding.icon_url).toBeNull();
});

test('uploadAccountBrandingAsset → multipart POST to /assets/:kind with the file under `file`', async () => {
  nextResponse = { status: 200, body: STATE };
  const file = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' });
  await uploadAccountBrandingAsset('acc-1', 'logo', file, 'logo.svg');
  expect(last().url).toBe('http://test.local/accounts/acc-1/branding/assets/logo');
  expect(last().method).toBe('POST');
  expect(last().body).toBeInstanceOf(FormData);
  const sent = (last().body as FormData).get('file');
  expect(sent).toBeInstanceOf(Blob);
  expect((sent as File).name).toBe('logo.svg');
  // The browser must set the multipart boundary itself — no JSON content type.
  expect(last().contentType).toBeNull();
});

test('dark variants are ordinary kinds on the same route', async () => {
  nextResponse = { status: 200, body: STATE };
  await uploadAccountBrandingAsset('acc-1', 'logo_dark', new Blob(['<svg/>']), 'dark.svg');
  expect(last().url).toBe('http://test.local/accounts/acc-1/branding/assets/logo_dark');
  await removeAccountBrandingAsset('acc-1', 'favicon_dark');
  expect(last().url).toBe('http://test.local/accounts/acc-1/branding/assets/favicon_dark');
});

test('removeAccountBrandingAsset → DELETE /assets/:kind', async () => {
  nextResponse = { status: 200, body: { ...STATE, branding: { ...STATE.branding, logo_url: null } } };
  const state = await removeAccountBrandingAsset('acc-1', 'logo');
  expect(last().url).toBe('http://test.local/accounts/acc-1/branding/assets/logo');
  expect(last().method).toBe('DELETE');
  expect(state.branding.logo_url).toBeNull();
});

test('resetAccountBranding → DELETE /accounts/:id/branding', async () => {
  nextResponse = {
    status: 200,
    body: {
      branding: {
        logo_url: null,
        icon_url: null,
        favicon_url: null,
        logo_dark_url: null,
        icon_dark_url: null,
        favicon_dark_url: null,
      },
      entitled: false,
    },
  };
  const state = await resetAccountBranding('acc-1');
  expect(last().url).toBe('http://test.local/accounts/acc-1/branding');
  expect(last().method).toBe('DELETE');
  expect(state.entitled).toBe(false);
});

test('listAccounts surfaces the effective branding the API attaches per account', async () => {
  nextResponse = {
    status: 200,
    body: [
      { account_id: 'acc-1', name: 'Acme', slug: 'acc-1', branding: STATE.branding },
      { account_id: 'acc-2', name: 'Personal', slug: 'acc-2', branding: null },
    ],
  };
  const accounts = await listAccounts();
  expect(accounts[0]?.branding?.logo_url).toContain('logo-abc.svg');
  expect(accounts[1]?.branding).toBeNull();
});
