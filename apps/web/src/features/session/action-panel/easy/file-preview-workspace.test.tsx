import { beforeEach, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as sdkReact from '@kortix/sdk/react';
import * as fileHooks from '@/features/files/hooks';
import { TooltipProvider } from '@/components/ui/tooltip';

let phase: 'idle' | 'resolving' | 'ready' | 'error' = 'resolving';
const workspaceCalls: unknown[][] = [];
const contentCalls: Array<{ enabled?: boolean } | undefined> = [];
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useSessionWorkspace: (...args: unknown[]) => {
    workspaceCalls.push(args);
    return { phase, retry: async () => undefined, runtimeUrl: null, error: null };
  },
}));
mock.module('@/features/files/hooks', () => ({
  ...fileHooks,
  useFileContent: (_path: string, options?: { enabled?: boolean }) => {
    contentCalls.push(options);
    return { data: undefined, isLoading: false, isError: false, error: null };
  },
}));
const { FilePreview } = await import('./file-preview');

function render(name: string) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <FilePreview path={`/workspace/${name}`} name={name}
          shareContext={{ projectId: 'project-1', sessionId: 'session-1' }} onClose={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  phase = 'resolving';
  workspaceCalls.length = 0;
  contentCalls.length = 0;
});

test('opening a text output resolves its session workspace before reading content', () => {
  const html = render('proof.txt');
  expect(workspaceCalls).toEqual([['project-1', 'session-1', { enabled: true }]]);
  expect(contentCalls.at(-1)?.enabled).toBe(false);
  expect(html).toContain('Waking up the workspace');
  expect(html).not.toContain("This file couldn&#x27;t be opened");
});

test('a rich output waits for the environment before mounting its renderer', () => {
  const html = render('proof.pdf');
  expect(contentCalls.at(-1)?.enabled).toBe(false);
  expect(html).toContain('Waking up the workspace');
  expect(html).not.toContain('<iframe');
});

test('a ready workspace enables the text file read', () => {
  phase = 'ready';
  render('proof.txt');
  expect(contentCalls.at(-1)?.enabled).toBe(true);
});

test('a failed workspace offers retry without starting a file read', () => {
  phase = 'error';
  const html = render('proof.txt');
  expect(contentCalls.at(-1)?.enabled).toBe(false);
  expect(html).toContain('Retry');
  expect(html).toContain('Could not open the workspace');
});
