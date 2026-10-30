import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { adoptSentAttachmentPreviews } from '../composer/sent-attachment-previews';

const win = new Window({ url: 'http://localhost:13000' });
Object.assign(globalThis, {
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  window: win,
  document: win.document,
  navigator: win.navigator,
  customElements: win.customElements,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
});
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globalThis))
    Object.defineProperty(globalThis, key, { value: Reflect.get(win, key), configurable: true });
}

const { MessageAttachments } = await import('./user-message');
const { TooltipProvider } = await import('../../primitives/tooltip');

describe('transcript attachment preview', () => {
  test.each(['text/plain', '', 'application/octet-stream'])(
    'clicking sent text (%s) opens its bytes in-app, with download secondary',
    async (mime) => {
      const file = new File(['dogfood-synthetic alpha'], 'notes.txt', { type: 'text/plain' });
      adoptSentAttachmentPreviews([
        {
          kind: 'local',
          isImage: false,
          uploadId: 'preview-test',
          file,
          localUrl: 'data:text/plain,dogfood-synthetic%20alpha',
        },
      ]);
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(
            <QueryClientProvider client={new QueryClient()}>
              <TooltipProvider>
                <MessageAttachments
                  attachments={[
                    {
                      key: 'preview-test',
                      id: 'preview-test',
                      filename: 'notes.txt',
                      mime,
                    },
                  ]}
                />
              </TooltipProvider>
            </QueryClientProvider>,
          ),
        );
        await act(async () => {
          host.querySelector('button')!.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(document.body.textContent).toContain('dogfood-synthetic alpha');
        expect(
          document.querySelector('[role="dialog"] button[aria-label="Download"]'),
        ).not.toBeNull();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );
});
