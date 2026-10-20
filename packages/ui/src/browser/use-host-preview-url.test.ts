import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { UiPreviewRequest, UiPreviewUrlResolver } from '../providers/ui-provider';
import { type HostPreviewUrl, useHostPreviewUrl } from './use-host-preview-url';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request: UiPreviewRequest = { projectId: 'p1', sessionId: 's1', port: 8123, path: '/', url: 'http://localhost:8123/' };

async function render(resolve: UiPreviewUrlResolver | undefined, req: UiPreviewRequest | null) {
  const seen: HostPreviewUrl[] = [];
  const Probe = () => {
    seen.push(useHostPreviewUrl(resolve, req));
    return null;
  };
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(Probe));
  });
  await act(async () => root.unmount());
  return seen;
}

describe('useHostPreviewUrl', () => {
  test('no resolver: not handled, the SDK default frames the URL', async () => {
    expect((await render(undefined, request)).at(-1)).toEqual({ handled: false, url: null, failed: false });
  });

  test('the resolver gets the request and its URL is framed, pending first', async () => {
    const asked: UiPreviewRequest[] = [];
    const seen = await render(async (r) => {
      asked.push(r);
      return 'https://host.example/preview?scoped=1';
    }, request);
    expect(asked).toEqual([request]);
    expect(seen[0]).toEqual({ handled: true, url: null, failed: false });
    expect(seen.at(-1)).toEqual({ handled: true, url: 'https://host.example/preview?scoped=1', failed: false });
  });

  test('null from the resolver falls back to the default; a throw is a failure', async () => {
    expect((await render(async () => null, request)).at(-1)?.handled).toBe(false);
    expect((await render(async () => Promise.reject(new Error('403')), request)).at(-1)).toEqual({
      handled: true,
      url: null,
      failed: true,
    });
  });
});
