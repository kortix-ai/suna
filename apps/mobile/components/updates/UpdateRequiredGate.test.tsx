/**
 * The minimum-version gate (P4.6): the app asks the API for its release policy
 * (`GET /v1/clients/mobile`, no token) and blocks a binary older than
 * `minimum_version`. It fails open: an error, a non-200 answer, a null or
 * unparsable minimum never shows the gate.
 *
 * The SDK is real: `configureKortix({ fetch })` stands in for the network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '@kortix/sdk';

import en from '../../locales/en.json';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

const platform = { OS: 'ios' };
const opened: string[] = [];
const constants: { nativeAppVersion: string | null; expoConfig: { version: string } | null } = {
  nativeAppVersion: '1.5.0',
  expoConfig: { version: '1.5.0' },
};

mock.module('react-native', () => ({
  View: host('view'),
  Platform: platform,
  StyleSheet: { absoluteFill: {}, flatten: (s: unknown) => s, create: (s: unknown) => s },
}));
mock.module('expo-constants', () => ({ default: constants }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en),
  }),
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/lib/utils/open-link', () => ({
  openLink: async (url: string) => {
    opened.push(url);
  },
}));
mock.module('@/lib/logger', () => ({ log: { error: () => {}, warn: () => {}, info: () => {}, log: () => {} } }));

let UpdateRequiredGate: typeof import('./UpdateRequiredGate').UpdateRequiredGate;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ UpdateRequiredGate } = await import('./UpdateRequiredGate'));
});

let answer: () => Promise<Response>;
let requests: Array<{ url: string; authorization: string | null }>;
beforeEach(() => {
  requests = [];
  constants.nativeAppVersion = '1.5.0';
  constants.expoConfig = { version: '1.5.0' };
  platform.OS = 'ios';
  opened.length = 0;
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => null,
    fetch: async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return answer();
    },
  });
});

const policy = (over: Record<string, string | null> = {}) =>
  new Response(
    JSON.stringify({ minimum_version: null, store_url_ios: null, store_url_android: null, ...over }),
    { status: 200 },
  );

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    tree = create(
      React.createElement(QueryClientProvider, { client }, React.createElement(UpdateRequiredGate)),
    );
  });
  // Let the query settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return tree!;
}

const text = (t: ReactTestRenderer) =>
  t.root.findAllByType('text' as never).map((n) => String(n.props.children));

describe('UpdateRequiredGate', () => {
  test('a build below the minimum shows the blocking prompt, and the request carries no token', async () => {
    answer = async () => policy({ minimum_version: '1.6.0', store_url_ios: 'https://apps.example.test/ios' });
    const t = await render();
    expect(text(t)).toEqual([en.updateRequired.title, en.updateRequired.body, en.updateRequired.button]);
    expect(requests).toEqual([{ url: 'http://backend.test/v1/clients/mobile', authorization: null }]);
  });

  test('the Update button opens the store URL of the running platform', async () => {
    answer = async () =>
      policy({
        minimum_version: '1.6.0',
        store_url_ios: 'https://apps.example.test/ios',
        store_url_android: 'https://apps.example.test/android',
      });
    platform.OS = 'android';
    const t = await render();
    await act(async () => {
      t.root.findByType('button' as never).props.onPress();
    });
    expect(opened).toEqual(['https://apps.example.test/android']);
  });

  test('without a store URL for the platform the button is hidden and the text says to update from the store', async () => {
    answer = async () => policy({ minimum_version: '1.6.0', store_url_android: 'https://apps.example.test/android' });
    const t = await render();
    expect(text(t)).toEqual([en.updateRequired.title, en.updateRequired.bodyNoStore]);
    expect(t.root.findAllByType('button' as never)).toHaveLength(0);
  });

  test('a build equal to the minimum, or newer, shows nothing', async () => {
    answer = async () => policy({ minimum_version: '1.5.0', store_url_ios: 'https://apps.example.test/ios' });
    expect((await render()).toJSON()).toBeNull();
    act(() => tree?.unmount());
    constants.nativeAppVersion = '1.5.1';
    expect((await render()).toJSON()).toBeNull();
  });

  test('the native binary version wins; expoConfig.version is the fallback', async () => {
    answer = async () => policy({ minimum_version: '1.6.0' });
    constants.nativeAppVersion = '1.7.0';
    expect((await render()).toJSON()).toBeNull();
    act(() => tree?.unmount());
    constants.nativeAppVersion = null;
    constants.expoConfig = { version: '1.5.0' };
    expect((await render()).toJSON()).not.toBeNull();
  });

  test('fails open: a null minimum, an unparsable minimum, a non-200 answer, a network error', async () => {
    for (const next of [
      async () => policy(),
      async () => policy({ minimum_version: 'soon' }),
      async () => new Response('down', { status: 503 }),
      async () => {
        throw new TypeError('Network request failed');
      },
    ]) {
      answer = next;
      expect((await render()).toJSON()).toBeNull();
      act(() => tree?.unmount());
    }
  });

  test('an unknown own version (no native version, no config) fails open', async () => {
    answer = async () => policy({ minimum_version: '1.6.0' });
    constants.nativeAppVersion = null;
    constants.expoConfig = null;
    expect((await render()).toJSON()).toBeNull();
  });
});

describe('mount position', () => {
  test('the gate is the last thing in the root layout: after the overlay portal, outside the sheet provider', () => {
    const layout = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../app/_layout.tsx'), 'utf8') as string;
    const sheets = layout.indexOf('</BottomSheetModalProvider>');
    const overlay = layout.indexOf('<PortalHost name={OVERLAY_PORTAL_HOST} />');
    const gate = layout.indexOf('<UpdateRequiredGate />');
    expect(sheets).toBeGreaterThan(0);
    expect(overlay).toBeGreaterThan(sheets);
    expect(gate).toBeGreaterThan(overlay);
    expect(layout.indexOf('</ToastProvider>')).toBeGreaterThan(gate);
  });
});

describe('locales', () => {
  for (const locale of ['de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'zh']) {
    test(`${locale} has the four update-required strings`, () => {
      const copy = require(`../../locales/${locale}.json`).updateRequired;
      for (const key of ['title', 'body', 'bodyNoStore', 'button']) expect(typeof copy[key]).toBe('string');
    });
  }
});
