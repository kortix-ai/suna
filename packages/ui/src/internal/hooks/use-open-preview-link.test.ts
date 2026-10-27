import { describe, expect, test } from 'bun:test';

import type { UiPreviewRequest } from '../../providers/ui-provider';
import { openHostPreview, type PreviewTab } from './use-open-preview-link';

const ids = { projectId: 'project-1', sessionId: 'session-1' };

function fakeTab() {
  const tab = { opener: 'host' as unknown, loaded: null as string | null, closed: false };
  const handle: PreviewTab = {
    get opener() {
      return tab.opener;
    },
    set opener(v) {
      tab.opener = v;
    },
    location: { replace: (url) => void (tab.loaded = url) },
    close: () => void (tab.closed = true),
  };
  return { tab, handle };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('openHostPreview', () => {
  test('loads the URL the host resolves for the sandbox port and path', async () => {
    const seen: UiPreviewRequest[] = [];
    const { tab, handle } = fakeTab();
    const opened = openHostPreview(
      async (req) => {
        seen.push(req);
        return 'https://preview.example.test/?token=scoped';
      },
      ids,
      'http://localhost:8081/docs',
      'http://p8081-sbx.localhost:3045/docs',
      () => handle,
    );
    expect(opened).toBe(true);
    expect(tab.opener).toBeNull();
    await flush();
    expect(seen).toEqual([{ ...ids, port: 8081, path: '/docs', url: 'http://localhost:8081/docs' }]);
    expect(tab.loaded).toBe('https://preview.example.test/?token=scoped');
  });

  test('a null answer loads the fallback, a failure closes the tab', async () => {
    const a = fakeTab();
    openHostPreview(async () => null, ids, 'http://localhost:3000/', 'http://fallback.test/', () => a.handle);
    const b = fakeTab();
    openHostPreview(() => Promise.reject(new Error('403')), ids, 'http://localhost:3000/', 'x', () => b.handle);
    await flush();
    expect(a.tab.loaded).toBe('http://fallback.test/');
    expect(b.tab.closed).toBe(true);
    expect(b.tab.loaded).toBeNull();
  });

  test('a URL outside the sandbox opens nothing', () => {
    let opens = 0;
    const opened = openHostPreview(async () => 'x', ids, 'https://example.com/', 'x', () => {
      opens += 1;
      return fakeTab().handle;
    });
    expect(opened).toBe(false);
    expect(opens).toBe(0);
  });
});
