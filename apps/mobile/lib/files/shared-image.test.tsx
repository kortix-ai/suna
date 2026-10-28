import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { clearSharedImages, rememberSharedImage, useSharedImage, type SharedImage } from './shared-image';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const SANDBOX = 'https://sandbox.example/v1/p/synthetic/8000';
const FOX = '/workspace/output/images/fox.png';
const SHA = 'a'.repeat(64);
const uri = `${SANDBOX}/file/raw?path=${encodeURIComponent(FOX)}`;

let seen: SharedImage | null = null;
function Probe({ path, sha256 }: { path: string; sha256?: string }) {
  const image = useSharedImage(SANDBOX, path, sha256);
  React.useEffect(() => {
    seen = image;
  });
  return null;
}
let tree: ReactTestRenderer | undefined;
async function look(path: string, sha256?: string) {
  await act(async () => {
    tree = create(<Probe path={path} sha256={sha256} />);
  });
  const found = seen;
  await act(async () => tree?.unmount());
  return found;
}
afterEach(() => {
  clearSharedImages();
  seen = null;
});

test('a new token replaces the stored Authorization header', async () => {
  rememberSharedImage(SANDBOX, FOX, SHA, { uri, headers: { Authorization: 'Bearer first' } });
  rememberSharedImage(SANDBOX, FOX, SHA, { uri, headers: { Authorization: 'Bearer second' } });
  expect((await look(FOX))?.source.headers).toEqual({ Authorization: 'Bearer second' });
  expect((await look('/workspace/drives/fox.png', SHA))?.source.headers).toEqual({ Authorization: 'Bearer second' });
});

test('a lookup with another sha256 is a miss, even at the same path', async () => {
  rememberSharedImage(SANDBOX, FOX, SHA, { uri });
  expect(await look(FOX, 'b'.repeat(64))).toBeNull();
});

test('a sign-out clears the store', async () => {
  rememberSharedImage(SANDBOX, FOX, SHA, { uri });
  clearSharedImages();
  expect(await look(FOX)).toBeNull();
  expect(await look(FOX, SHA)).toBeNull();
});
