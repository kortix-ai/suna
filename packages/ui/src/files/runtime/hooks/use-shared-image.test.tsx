import { toolCallBlock } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { ToolPart } from '../../../internal/session-types';
import { IntlTestProvider } from '../../../test-utils/intl';

/** Every path the file read was asked for; `null` is a read that is off. */
const reads: (string | null)[] = [];
const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
mock.module('./use-binary-blob', () => ({
  binaryBlobKeys: { all: ['runtime-files', 'binary-blob'], file: (s: string, p: string) => ['runtime-files', 'binary-blob', s, p] },
  useBinaryBlob: (path: string | null) => {
    reads.push(path);
    return path
      ? { blobUrl: 'blob:per-mount-read', blob: PNG, isLoading: false, error: null }
      : { blobUrl: null, blob: null, isLoading: false, error: null };
  },
}));
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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const FOX = '/workspace/output/images/fox.png';
const SHA = 'c'.repeat(64);

function providers(node: ReactNode) {
  return (
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
    </IntlTestProvider>
  );
}

const roots: ReactTestRenderer[] = [];
async function mount(node: ReactNode) {
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(providers(node));
  });
  roots.push(root!);
  return root!;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  reads.length = 0;
  textReads.length = 0;
});

let viewer: ReturnType<typeof useFileContentState> | undefined;
function Probe({ path, onState }: { path: string; onState: (state: ReturnType<typeof useFileContentState>) => void }) {
  onState(useFileContentState({ filePath: path, readOnly: true, markdownPreview: false }));
  return null;
}
const Viewer = ({ path }: { path: string }) => <Probe path={path} onState={(state) => (viewer = state)} />;

function generatedFox() {
  return toolCallBlock({
    type: 'tool',
    tool: 'image_gen',
    callID: 'call-img-1',
    state: {
      status: 'completed',
      input: { prompts: ['A fox'] },
      output: JSON.stringify({ images: [{ path: FOX, size: '1024x1024', prompt: 'A fox', sha256: SHA }] }),
      time: { start: 1 },
    },
  } as unknown as ToolPart);
}

test('full screen opens without a loading state when the card already loaded the image', async () => {
  const card = await mount(<ImageGenTool call={generatedFox()} />);
  const cardSrc = card.root.findByType('img').props.src as string;
  // The card draws the shared store's URL, not its own per-mount read.
  expect(cardSrc).toStartWith('blob:');
  expect(cardSrc).not.toBe('blob:per-mount-read');
  expect(reads.filter(Boolean)).toEqual([FOX]);

  reads.length = 0;
  await mount(
    <FileSourceProvider value={workspaceFileSource}>
      <Viewer path={FOX} />
    </FileSourceProvider>,
  );
  expect(viewer?.showLoadingState).toBe(false);
  expect(viewer?.imageDataUrl).toBe(cardSrc);
  expect(viewer?.isNotFound).toBe(false);
  // Nothing was read again: no bytes, no base64 text.
  expect(reads.filter(Boolean)).toEqual([]);
  expect(textReads.filter(Boolean)).toEqual([]);
});

test('on a miss the viewer reads the image once, as bytes, never as base64 text', async () => {
  await mount(
    <FileSourceProvider value={workspaceFileSource}>
      <Viewer path="/workspace/other.webp" />
    </FileSourceProvider>,
  );
  expect(reads.filter(Boolean)).toEqual(['/workspace/other.webp']);
  expect(textReads.filter(Boolean)).toEqual([]);
  expect(viewer?.imageDataUrl).toStartWith('blob:');
  expect(viewer?.imageDataUrl).not.toBe('blob:per-mount-read');
});

test('a show image with the same sha256 as a generated image renders from cache and is not drawn twice', async () => {
  const card = await mount(<ImageGenTool call={generatedFox()} />);
  const cardSrc = card.root.findByType('img').props.src as string;
  reads.length = 0;

  // A Drive copy of the same bytes, shown in another turn: drawn at once from the card's URL, never read.
  const DRIVE = '/drives/me/space/images/fox.png';
  const shown = await mount(<TooltipProvider><ShowContentRenderer type="image" path={DRIVE} sha256={SHA} /></TooltipProvider>);
  expect(shown.root.findAllByType('img').map((img) => img.props.src)).toEqual([cardSrc]);
  expect(reads.filter(Boolean)).toEqual([]);
  // The copy is linked: opened full screen by its own path, it is a hit too.
  await mount(
    <FileSourceProvider value={workspaceFileSource}>
      <Viewer path={DRIVE} />
    </FileSourceProvider>,
  );
  expect(viewer?.imageDataUrl).toBe(cardSrc);
  expect(reads.filter(Boolean)).toEqual([]);

  // In the card's own turn the show draws nothing for that image.
  const show = (input: Record<string, unknown>, output: Record<string, unknown>) =>
    toolCallBlock({ type: 'tool', tool: 'show', callID: 'call-show', state: { status: 'completed', input, output: JSON.stringify(output) } } as unknown as ToolPart);
  // The show card's preview and tooltip effects listen on `window`.
  const win = new Window();
  const globals: Record<string, unknown> = {
    window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element,
    Node: win.Node, MutationObserver: win.MutationObserver, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const inTurn = (node: ReactNode) => <TooltipProvider><ImageGenDigestsContext.Provider value={new Set([SHA])}>{node}</ImageGenDigestsContext.Provider></TooltipProvider>;
  const only = await mount(inTurn(<ShowTool call={show({ type: 'image', path: DRIVE }, { entry: { type: 'image', path: DRIVE, sha256: SHA } })} />));
  expect(only.toJSON()).toBeNull();
  // A show that also carries a non-image keeps that item and drops the image.
  const items = [{ type: 'image', title: 'Fox', path: DRIVE }, { type: 'code', title: 'Notes', content: 'const fox = 1;', language: 'ts' }];
  const mixed = await mount(inTurn(<ShowTool call={show({ items: JSON.stringify(items) }, { items: [{ ...items[0], sha256: SHA }, items[1]] })} />));
  expect(mixed.root.findAllByType('img')).toHaveLength(0);
  expect(JSON.stringify(mixed.toJSON())).toContain('Notes');
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  await win.happyDOM.abort();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
