import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useToolPreviewStore } from '@/stores/tool-preview-store';

const Pass = ({ children }: { children?: React.ReactNode }) => children;
const WebView = (_props: { source: { uri: string; headers?: Record<string, string> } }) => null;
const Button = (_props: { children?: React.ReactNode; onPress: () => void }) => null;
let resolveToken: () => Promise<string | null> = async () => 'first';
// The SDK's `authenticatedRequest` rejects without a token.
const authenticatedRequest = mock(async (url: string) => {
  const token = await resolveToken();
  if (!token) throw new Error('Synthetic missing token');
  return { url, headers: { authorization: `Bearer ${token}` } };
});
mock.module('react-native', () => ({ View: Pass }));
mock.module('react-native-webview', () => ({ WebView }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
mock.module('@/api/config', () => ({ API_URL: 'https://api.example.test/v1' }));
mock.module('@kortix/sdk', () => ({ authenticatedRequest }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: () => null }));
mock.module('@/components/kortix/sheet', () => ({ KortixBottomSheetModal: Pass }));
mock.module('@/components/ui/button', () => ({ Button }));
mock.module('@/components/ui/text', () => ({ Text: Pass }));
mock.module('@/lib/utils/theme', () => ({ THEME: { light: { background: 'white' }, dark: { background: 'black' } } }));

let SandboxPreviewSheet: typeof import('./SandboxPreviewSheet').SandboxPreviewSheet;
let tree: ReactTestRenderer | undefined;
beforeAll(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  SandboxPreviewSheet = (await import('./SandboxPreviewSheet')).SandboxPreviewSheet;
});
beforeEach(() => {
  useToolPreviewStore.getState().closePreview();
  authenticatedRequest.mockClear();
  resolveToken = async () => 'first';
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
});
async function mount() {
  await act(async () => { tree = create(<SandboxPreviewSheet />); });
}
async function open(url = 'https://api.example.test/v1/p/synthetic/3000') {
  await act(async () => { useToolPreviewStore.getState().openPreview(url); });
}
function views() {
  if (!tree) throw new Error('Not mounted');
  return tree.root.findAllByType(WebView);
}
function retry() {
  if (!tree) throw new Error('Not mounted');
  return tree.root.findByType(Button).props.onPress();
}

test('resolves the current token on every opening, including the same URL', async () => {
  await mount();
  expect(authenticatedRequest).toHaveBeenCalledTimes(0);
  await open();
  expect(views()[0].props.source.headers).toEqual({ authorization: 'Bearer first' });
  await act(async () => { useToolPreviewStore.getState().closePreview(); });
  resolveToken = async () => 'second';
  await open();
  expect(authenticatedRequest).toHaveBeenCalledTimes(2);
  expect(views()[0].props.source.headers).toEqual({ authorization: 'Bearer second' });
});

test('public previews render without resolving or sending credentials', async () => {
  await mount();
  await open('https://public.example.test/app');
  expect(views()).toHaveLength(1);
  expect(views()[0].props.source.headers).toBeUndefined();
  expect(authenticatedRequest).toHaveBeenCalledTimes(0);
});

for (const failure of ['missing', 'rejected']) {
  test(`${failure} credentials can be retried`, async () => {
    resolveToken = async () => {
      if (failure === 'rejected') throw new Error('Synthetic auth failure');
      return null;
    };
    await mount();
    await open();
    expect(views()).toHaveLength(0);
    resolveToken = async () => 'retried';
    await act(async () => { retry(); });
    expect(views()[0].props.source.headers).toEqual({ authorization: 'Bearer retried' });
  });
}

test('a superseded response never populates the current preview', async () => {
  let finish: (token: string) => void = () => { throw new Error('No pending request'); };
  resolveToken = () => new Promise((resolve) => { finish = resolve; });
  await mount();
  await open();
  expect(views()).toHaveLength(0);
  resolveToken = async () => 'current';
  await open('https://api.example.test/v1/p/synthetic/4000');
  await act(async () => { finish('obsolete'); });
  expect(views()[0].props.source.headers).toEqual({ authorization: 'Bearer current' });
});

test('changing a trusted URL unmounts its old credential before the next request resolves', async () => {
  await mount();
  await open();
  resolveToken = () => new Promise(() => {});
  await open('https://api.example.test/v1/p/synthetic/4000');
  expect(views()).toHaveLength(0);
});
