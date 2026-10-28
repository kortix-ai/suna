/**
 * R38 shared images, through the real read: `useBinaryBlob` and React Query,
 * with only the network read (`readFileAsBlob`) and the base64 text read
 * stubbed. One QueryClient for the page, as the app has.
 */
import { toolCallBlock } from '@kortix/sdk';
import { binaryBlobKeys } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { ToolPart } from '../../../internal/session-types';
import { IntlTestProvider } from '../../../test-utils/intl';

/** The sandbox's files: path → bytes. Every network read is logged. */
const files = new Map<string, Uint8Array<ArrayBuffer>>();
const reads: string[] = [];
const realFiles = await import('../../../internal/files/runtime-files');
mock.module('../../../internal/files/runtime-files', () => ({
  ...realFiles,
  readFileAsBlob: async (path: string) => {
    reads.push(path);
    const bytes = files.get(path);
    if (!bytes) throw new Error('404 not found');
    return new Blob([bytes], { type: 'image/png' });
  },
}));
mock.module('../../../internal/files/runtime-file-read', () => ({
  readRuntimeFileWithRetry: (_path: string, read: () => Promise<unknown>) => read(),
}));
mock.module('./use-server-health', () => ({ useServerHealth: () => ({ parked: false }), useCurrentProject: () => ({}) }));
/** The base64 text read the viewer used for images before R38. */
const textReads: (string | null)[] = [];
mock.module('./use-file-content', () => ({
  fileContentKeys: { all: ['runtime-files', 'content'], file: (s: string, p: string) => ['runtime-files', 'content', s, p] },
  useFileContent: (path: string | null) => {
    textReads.push(path);
    return { data: undefined, isLoading: !!path, error: null, refetch: async () => undefined };
  },
  useInvalidateFileContent: () => () => undefined,
}));

const { ImageGenTool } = await import('../../../session/tool/tools/image-gen-tool');
const { workspaceFileSource } = await import('../file-source');
const { FileSourceProvider } = await import('../../viewer/file-source');
const { useFileContentState } = await import('../../viewer/use-file-content-state');
const { ShowContentRenderer } = await import('../../renderers/show-content-renderer');
const { ShowTool } = await import('../../../session/tool/tools/show-tool');
const { ImageGenDigestsContext } = await import('../../../session/tool/shared/infrastructure');
const { TooltipProvider } = await import('../../../primitives/tooltip');
const { clearSharedImages } = await import('./use-shared-image');
const { useFileRefresh } = await import('./use-file-refresh');
const { useFilePreviewStore } = await import('../../../internal/stores/file-preview-store');
const { useCurrentAccountStore } = await import('../../../internal/stores/current-account-store');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const FOX = '/workspace/output/images/fox.png';
const DRIVE = '/drives/me/space/images/fox.png';
const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]);
async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const SHA_A = await sha(PNG_A);
const SHA_B = await sha(PNG_B);

let queryClient: QueryClient;
const roots: ReactTestRenderer[] = [];
const saved = new Map<string, PropertyDescriptor | undefined>();
let win: Window;

beforeEach(() => {
  // Order-independent: a fresh page per test.
  clearSharedImages();
  useFilePreviewStore.setState({ captions: {} });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  files.clear();
  reads.length = 0;
  textReads.length = 0;
  // The show card's preview and tooltip effects listen on `window`.
  win = new Window();
  const globals: Record<string, unknown> = {
    window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element,
    Node: win.Node, MutationObserver: win.MutationObserver, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  queryClient.clear();
  await win.happyDOM.abort();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

/** Lets the reads resolve and the effects run. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function mount(node: ReactNode) {
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(
      <IntlTestProvider locale="en" onError={() => {}}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{node}</TooltipProvider>
        </QueryClientProvider>
      </IntlTestProvider>,
    );
  });
  roots.push(root!);
  await settle();
  return root!;
}
const srcs = (root: ReactTestRenderer) => root.root.findAllByType('img').map((img) => img.props.src as string);

let viewer: ReturnType<typeof useFileContentState> | undefined;
function Probe({ path, onState }: { path: string; onState: (state: ReturnType<typeof useFileContentState>) => void }) {
  onState(useFileContentState({ filePath: path, readOnly: true, markdownPreview: false }));
  return null;
}
const Viewer = ({ path }: { path: string }) => (
  <FileSourceProvider value={workspaceFileSource}>
    <Probe path={path} onState={(state) => (viewer = state)} />
  </FileSourceProvider>
);
let refresh: (() => void) | undefined;
function RefreshHook({ path, onRefresh }: { path: string; onRefresh: (refresh: () => void) => void }) {
  onRefresh(useFileRefresh(path).refresh);
  return null;
}
const RefreshProbe = ({ path }: { path: string }) => <RefreshHook path={path} onRefresh={(next) => (refresh = next)} />;

function generated(path: string, digest?: string) {
  return toolCallBlock({
    type: 'tool',
    tool: 'image_gen',
    callID: 'call-img-1',
    state: {
      status: 'completed',
      input: { prompts: ['A fox'] },
      output: JSON.stringify({ images: [{ path, size: '1024x1024', prompt: 'A fox', ...(digest && { sha256: digest }) }] }),
      time: { start: 1 },
    },
  } as unknown as ToolPart);
}

test('full screen opens without a loading state when the card already loaded the image', async () => {
  files.set(FOX, PNG_A);
  const card = await mount(<ImageGenTool call={generated(FOX, SHA_A)} />);
  const [cardSrc] = srcs(card);
  expect(cardSrc).toStartWith('blob:');
  expect(reads).toEqual([FOX]);

  // Opened from the Files list (the path only): the one shared read, no second fetch, no loading.
  await mount(<Viewer path={FOX} />);
  expect(viewer?.showLoadingState).toBe(false);
  expect(viewer?.isNotFound).toBe(false);
  expect(viewer?.imageDataUrl).toBe(cardSrc);
  // Opened from the card (its caption names the digest): drawn from the store.
  useFilePreviewStore.getState().openPreview(FOX, undefined, { text: 'A fox', sha256: SHA_A });
  await mount(<Viewer path={FOX} />);
  expect(viewer?.showLoadingState).toBe(false);
  expect(viewer?.imageDataUrl).toBe(cardSrc);
  expect(reads).toEqual([FOX]);
  expect(textReads.filter(Boolean)).toEqual([]);
});

test('on a miss the viewer reads the image once, as bytes, never as base64 text', async () => {
  files.set('/workspace/other.webp', PNG_B);
  await mount(<Viewer path="/workspace/other.webp" />);
  expect(reads).toEqual(['/workspace/other.webp']);
  expect(textReads.filter(Boolean)).toEqual([]);
  expect(viewer?.imageDataUrl).toStartWith('blob:');
});

test('a show image with the same sha256 as a generated image renders from cache and is not drawn twice', async () => {
  files.set(FOX, PNG_A);
  const card = await mount(<ImageGenTool call={generated(FOX, SHA_A)} />);
  const [cardSrc] = srcs(card);
  reads.length = 0;

  // A Drive copy of the same bytes, shown in another turn: drawn at once from the card's URL, never read.
  const shown = await mount(<ShowContentRenderer type="image" path={DRIVE} sha256={SHA_A} />);
  expect(srcs(shown)).toEqual([cardSrc]);
  expect(reads).toEqual([]);

  // In the card's own turn the show draws nothing for that image.
  const show = (input: Record<string, unknown>, output: Record<string, unknown>) =>
    toolCallBlock({ type: 'tool', tool: 'show', callID: 'call-show', state: { status: 'completed', input, output: JSON.stringify(output) } } as unknown as ToolPart);
  const inTurn = (node: ReactNode) => <ImageGenDigestsContext.Provider value={new Set([SHA_A])}>{node}</ImageGenDigestsContext.Provider>;
  const only = await mount(inTurn(<ShowTool call={show({ type: 'image', path: DRIVE }, { entry: { type: 'image', path: DRIVE, sha256: SHA_A } })} />));
  expect(only.toJSON()).toBeNull();
  const items = [{ type: 'image', title: 'Fox', path: DRIVE }, { type: 'code', title: 'Notes', content: 'const fox = 1;', language: 'ts' }];
  const mixed = await mount(inTurn(<ShowTool call={show({ items: JSON.stringify(items) }, { items: [{ ...items[0], sha256: SHA_A }, items[1]] })} />));
  expect(mixed.root.findAllByType('img')).toHaveLength(0);
  expect(JSON.stringify(mixed.toJSON())).toContain('Notes');
});

test('a sha256 that disagrees with the bytes at a path is a miss: the path is read again and the new bytes drawn', async () => {
  files.set(FOX, PNG_A);
  const card = await mount(<ImageGenTool call={generated(FOX, SHA_A)} />);
  const [oldSrc] = srcs(card);
  // The file was rewritten; a later show names the new bytes at the same path.
  files.set(FOX, PNG_B);
  reads.length = 0;
  const shown = await mount(<ShowContentRenderer type="image" path={FOX} sha256={SHA_B} />);
  expect(reads).toEqual([FOX]);
  const [newSrc] = srcs(shown);
  expect(newSrc).not.toBe(oldSrc);
  expect(await (await fetch(newSrc!)).bytes()).toEqual(PNG_B);
  // A claimed digest the bytes do not match is never stored: a later lookup by it reads.
  reads.length = 0;
  await mount(<ShowContentRenderer type="image" path="/workspace/elsewhere.png" sha256={'f'.repeat(64)} />);
  expect(reads).toEqual(['/workspace/elsewhere.png']);
});

// A chart the agent re-renders at the same path draws its new bytes on every surface,
// for each signal that already invalidates file bytes.
const CHART = '/workspace/plot.png';
const signals: [string, () => Promise<unknown> | void][] = [
  // `file.edited` (handle-workspace-event.ts): the active blob queries.
  ['file.edited', () => queryClient.invalidateQueries({ queryKey: binaryBlobKeys.all, type: 'active' })],
  // Turn end (`invalidateWorkspaceFilesAfterTurn`, handle-event.ts): every blob query.
  ['the turn end', () => queryClient.invalidateQueries({ queryKey: binaryBlobKeys.all })],
  // The show card's Refresh (`ShowFileActions`, show-helpers.tsx): every blob query.
  ["the show card's Refresh", () => queryClient.invalidateQueries({ queryKey: binaryBlobKeys.all })],
  // The viewer's Refresh (`useFileRefresh`).
  ["the viewer's Refresh", () => refresh?.()],
];
for (const [signal, invalidate] of signals) {
  test(`a chart rewritten at the same path shows its new bytes after ${signal}`, async () => {
    files.set(CHART, PNG_A);
    const shown = await mount(<ShowContentRenderer type="image" path={CHART} />);
    await mount(<><Viewer path={CHART} /><RefreshProbe path={CHART} /></>);
    const [before] = srcs(shown);
    expect(viewer?.imageDataUrl).toBe(before);
    expect(reads).toEqual([CHART]);

    files.set(CHART, PNG_B);
    await act(async () => { await invalidate(); });
    await settle();
    const [after] = srcs(shown);
    expect(after).not.toBe(before);
    expect(viewer?.imageDataUrl).toBe(after);
    expect(await (await fetch(after!)).bytes()).toEqual(PNG_B);
  });
}

test('unchanged bytes keep their URL through an invalidation: nothing reloads', async () => {
  files.set(CHART, PNG_A);
  const shown = await mount(<ShowContentRenderer type="image" path={CHART} />);
  const [before] = srcs(shown);
  await act(async () => { await queryClient.invalidateQueries({ queryKey: binaryBlobKeys.all }); });
  await settle();
  expect(reads).toEqual([CHART, CHART]);
  expect(srcs(shown)).toEqual([before]);
});

test('a sign-out or an account switch clears the stored digests', async () => {
  files.set(FOX, PNG_A);
  await mount(<ImageGenTool call={generated(FOX, SHA_A)} />);
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  useCurrentAccountStore.getState().setSelectedAccountId('synthetic-account-2');
  reads.length = 0;
  files.set(DRIVE, PNG_A);
  await mount(<ShowContentRenderer type="image" path={DRIVE} sha256={SHA_A} />);
  // The digest is gone: the copy is read from its own path.
  expect(reads).toEqual([DRIVE]);
  useCurrentAccountStore.getState().clear();
});
