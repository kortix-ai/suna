import { toolCallBlock } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ToolPart } from '../../../internal/session-types';
import { TooltipProvider } from '../../../primitives/tooltip';
import * as uiProvider from '../../../providers/ui-provider';
import { IntlTestProvider } from '../../../test-utils/intl';
import * as sdkReact from '@kortix/sdk/react';
import { useFilePreviewStore } from '../../../internal/stores/file-preview-store';
import { useKortixComputerStore } from '../../../internal/stores/kortix-computer-store';
import { ImageGenRunsContext, InTranscriptTurnContext, ReadOnlySessionContext, TurnLiveContext } from '../shared/infrastructure';
import { ImageGenTool } from './image-gen-tool';

// The file read, as the card sees it: still loading by default.
let blob: { blobUrl: string | null; blob: Blob | null; isLoading: boolean; error: string | null } = {
  blobUrl: null, blob: null, isLoading: true, error: null,
};
mock.module('../../../files/runtime/hooks/use-binary-blob', () => ({ useBinaryBlob: () => blob }));

// The model picker's connect routing, as the card sees it: a project with the
// provider modal mounted. `opened` records each tab the card asked to open.
const opened: string[] = [];
let canConnectProvider = true;
/** `project.model.write` for the viewer. */
let canWriteProviders = true;
mock.module('../../models/use-model-connection-gate', () => ({
  useModelConnectionGate: () => ({
    canConnectProvider,
    canWriteProviders,
    openConnectProvider: (tab: string) => opened.push(tab),
    modal: <div data-provider-modal="" />,
  }),
}));

// The session error banner's ChatGPT fix, as the card sees it (its own rules
// live in `chatGptActionApplies`, tested beside it).
mock.module('../../models/chatgpt-connection-button', () => ({
  ChatGptConnectionSlot: ({ action }: { action: string }) => <button data-chatgpt-slot={action}>ChatGPT {action}</button>,
}));

// Whose session this is: private to the viewer by default.
const VIEWER = 'user-viewer';
let sessionRow: { visibility: string; created_by: string } = { visibility: 'private', created_by: VIEWER };
let readOnly = false;
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, useProjectSession: () => ({ data: sessionRow }) }));
mock.module('../../../providers/ui-provider', () => ({ ...uiProvider, useUiViewerId: () => VIEWER }));

/** The tool's batch output for the given images (`[path, size, prompt]`) and failed prompts. */
function batch(images: [string, string, string][], failed: { prompt: string; error: string }[] = [], model = 'codex/gpt-image-2') {
  return JSON.stringify({
    action: 'generate',
    model,
    provider: 'openai-codex',
    images: images.map(([path, size, prompt]) => ({ path, size, prompt })),
    ...(failed.length ? { failed } : {}),
  });
}
const FOX = '/workspace/output/images/fox.png';
const THREE = ['A fox in a shuttle', 'An owl in a shuttle', 'A hare in a shuttle'];
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** The bento's rectangle: its tile count and its CSS aspect ratio (width over height). */
function bentoOf(html: string): { count: number; ratio: number } | null {
  const m = /data-image-gen-bento="(\d)"[^>]*style="aspect-ratio:([^";]+)/.exec(html);
  return m ? { count: Number(m[1]), ratio: Number(m[2]) } : null;
}

/**
 * The height a frame's inline style gives it in a `columnWidth` × `viewportHeight`
 * layout: its width is `min(100%, calc(60vh * r))` and its ratio `r` (R33).
 */
function heightAt(style: string, columnWidth: number, viewportHeight: number): number {
  const width = /width:min\(100%, calc\(60vh \* ([\d.]+)\)\)/.exec(style);
  const ratio = /aspect-ratio:([\d.]+)(?: \/ ([\d.]+))?/.exec(style);
  if (!width || !ratio) throw new Error(`no capped width or ratio in: ${style}`);
  const r = Number(ratio[1]) / Number(ratio[2] ?? 1);
  const w = Math.min(columnWidth, 0.6 * viewportHeight * Number(width[1]));
  return w / r;
}
const styleOf = (html: string, marker: string) => new RegExp(`${marker}[^>]*style="([^"]+)"`).exec(html)?.[1] ?? '';
/** Each tile's opening tag (its slot classes) and its markup up to the next tile. */
function tilesOf(html: string): { tag: string; body: string }[] {
  return html.split(/(?=<div[^>]*data-image-gen-tile=)/).slice(1).map((part) => ({ tag: part.slice(0, part.indexOf('>') + 1), body: part }));
}
/** The text a reader sees: markup and attributes (an image's `alt`) removed. */
const visibleText = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, ' ');

function card(state: Record<string, unknown>, turn?: { live: boolean }): ReactElement {
  const call = toolCallBlock({
    type: 'tool',
    tool: 'image_gen',
    callID: 'call-img-1',
    state: { input: { action: 'generate', prompts: ['A paper-cutout fox'], aspect_ratio: '3:2' }, time: { start: Date.now() - 42_000 }, ...state },
  } as unknown as ToolPart);
  return (
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ReadOnlySessionContext.Provider value={readOnly}>
          {turn ? (
            <InTranscriptTurnContext.Provider value>
              <TurnLiveContext.Provider value={turn.live}>
                <ImageGenTool call={call} />
              </TurnLiveContext.Provider>
            </InTranscriptTurnContext.Provider>
          ) : (
            <ImageGenTool call={call} />
          )}
          </ReadOnlySessionContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>
  );
}

function render(state: Record<string, unknown>, turn?: { live: boolean }) {
  return renderToStaticMarkup(card(state, turn));
}

/** Mounts the card in a happy-dom document, hands it to `run`, then restores the globals. */
async function inDom(state: Record<string, unknown>, run: (container: HTMLElement) => Promise<void>) {
  const win = new Window();
  const globals: Record<string, unknown> = {
    window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
    Element: win.Element, Node: win.Node, MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    // The dot matrix's frame loop calls these bare (`dotmatrix-hooks.ts`).
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const container = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  const root = createRoot(container);
  try {
    await act(async () => root.render(card(state)));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    // Stop happy-dom (its timers and frames) while `window` still exists, then
    // restore: a callback that ran after the restore threw "window is not defined".
    await win.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

describe('ImageGenTool', () => {
  test('generating holds the requested aspect with the busy line, elapsed time and the prompt', () => {
    const html = render({ status: 'running' });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aspect-ratio:3 / 2');
    expect(html).toContain('Generating image');
    expect(html).toContain('0:42');
    expect(html).toContain('role="status"'); // SessionDotMatrix
    expect(html).not.toContain('animate-spin');
  });

  test('a completed call loads the image file in the frame', () => {
    const html = render({ status: 'completed', output: batch([[FOX, '1536x1024', 'A paper-cutout fox']]) });
    expect(html).toContain('Loading image');
    expect(html).not.toContain('Generating image');
  });

  test('a three-prompt call shows three generating tiles, the busy glyph in each, one count and time', () => {
    const html = render({ status: 'running', input: { action: 'generate', prompts: THREE, aspect_ratio: '16:9' } });
    expect(tilesOf(html)).toHaveLength(3);
    expect(count(html, 'aria-busy="true"')).toBe(3);
    // The first tile names the batch and its time; the others carry the glyph alone.
    expect(count(html, 'Generating 3 images')).toBe(1);
    expect(count(html, '0:42')).toBe(1);
    expect(html).not.toContain('Generating image<');
    expect(render({ status: 'running', input: { action: 'edit', prompts: THREE.slice(0, 2) } })).toContain('Editing 2 images');
  });

  test('only the first generating frame is a status region; the other glyphs are hidden from assistive tech', async () => {
    await inDom({ status: 'running', input: { action: 'generate', prompts: THREE } }, async (container) => {
      const statuses = [...container.querySelectorAll('[role="status"]')];
      expect(statuses).toHaveLength(3);
      const exposed = statuses.filter((node) => !node.closest('[aria-hidden="true"]'));
      expect(exposed).toHaveLength(1);
      expect(exposed[0]!.parentElement?.textContent).toContain('Generating 3 images');
    });
  });

  test('three images render one large left tile and two stacked right tiles', () => {
    const input = { action: 'generate', prompts: THREE, aspect_ratio: '3:2' };
    const output = batch([
      [FOX, '1024x1024', THREE[0]!],
      ['/workspace/output/images/owl.png', '1024x1536', THREE[1]!],
      ['/workspace/output/images/hare.png', '1536x1024', THREE[2]!],
    ]);
    const html = render({ status: 'completed', input, output });
    // One rectangle, full width, sized from the requested 3:2 (left tile 2/3 wide and two rows tall: 1.5 × 3/2).
    expect(bentoOf(html)).toEqual({ count: 3, ratio: 2.25 });
    expect(html).toMatch(/data-image-gen-bento="3"[^>]*class="[^"]*grid-cols-3[^"]*grid-rows-2/);
    const tiles = tilesOf(html);
    expect(tiles.map((tile) => /col-span-2 row-span-2/.test(tile.tag))).toEqual([true, false, false]);
    // Tiles fill their slot and crop; they never take the image's own ratio.
    expect(html).not.toMatch(/data-image-gen-tile[\s\S]*aspect-ratio:1 \/ 1/);
    // The same slots while generating: nothing moves when the images land.
    const running = render({ status: 'running', input });
    expect(bentoOf(running)).toEqual({ count: 3, ratio: 2.25 });
    expect(tilesOf(running).map((tile) => tile.tag)).toEqual(tiles.map((tile) => tile.tag));
  });

  test('two and four images fill the rectangle', () => {
    const two = render({
      status: 'completed',
      input: { action: 'generate', prompts: ['a', 'b'], aspect_ratio: '3:2' },
      output: batch([[FOX, '1024x1024', 'a'], ['/workspace/output/images/b.png', '1024x1536', 'b']]),
    });
    // Side by side, equal width, one row: twice the tile ratio.
    expect(bentoOf(two)).toEqual({ count: 2, ratio: 3 });
    // One explicit row, and no content minimum: every row is minmax(0, 1fr).
    expect(two).toMatch(/data-image-gen-bento="2"[^>]*class="[^"]*min-h-0[^"]*grid-cols-2 grid-rows-1/);
    expect(tilesOf(two).every((tile) => !/span/.test(tile.tag))).toBe(true);
    const four = render({ status: 'running', input: { action: 'generate', prompts: ['a', 'b', 'c', 'd'], aspect_ratio: '1:1' } });
    // 2×2 of the tile ratio.
    expect(bentoOf(four)).toEqual({ count: 4, ratio: 1 });
    expect(four).toMatch(/data-image-gen-bento="4"[^>]*class="[^"]*grid-cols-2[^"]*grid-rows-2/);
    expect(tilesOf(four)).toHaveLength(4);
    // One image is a single frame at its own ratio, no rectangle.
    const one = render({ status: 'completed', output: batch([[FOX, '1024x1024', 'a']]) });
    expect(bentoOf(one)).toBeNull();
    expect(one).toContain('aspect-ratio:1 / 1');
  });

  test('a lone 9:16 at a 720×480 viewport is at most 288 px tall, and so is every rectangle', () => {
    // 60vh of 480 px is 288 px. The frame narrows to keep its ratio, never crops or letterboxes.
    const tall = render({ status: 'running', input: { action: 'generate', prompts: ['a'], aspect_ratio: '9:16' } });
    expect(heightAt(styleOf(tall, 'aria-busy="true"'), 720, 480)).toBeLessThanOrEqual(288);
    expect(heightAt(styleOf(tall, 'aria-busy="true"'), 720, 480)).toBeCloseTo(288);
    // Wide enough to fit, it keeps the column width.
    const wide = render({ status: 'running', input: { action: 'generate', prompts: ['a'], aspect_ratio: '16:9' } });
    expect(heightAt(styleOf(wide, 'aria-busy="true"'), 360, 480)).toBeCloseTo(360 / (16 / 9));
    for (const prompts of [['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']]) {
      const html = render({ status: 'running', input: { action: 'generate', prompts, aspect_ratio: '9:16' } });
      expect(heightAt(styleOf(html, 'data-image-gen-bento'), 720, 480)).toBeLessThanOrEqual(288 + 1e-9);
    }
  });

  test('the tile button names its full-screen action in the viewer\'s language', () => {
    blob = { blobUrl: 'blob:fox', blob: null, isLoading: false, error: null };
    try {
      const html = render({ status: 'completed', input: { action: 'generate', prompts: ['a fox'] }, output: batch([[FOX, '1024x1024', 'a fox']]) });
      expect(html).toContain('aria-label="Open full screen: a fox"');
      const legacy = render({ status: 'completed', input: {}, output: JSON.stringify({ path: FOX }) });
      expect(legacy).toContain('aria-label="Open full screen"');
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
    }
  });

  test('a failed tile keeps its slot', () => {
    const html = render({
      status: 'completed',
      input: { action: 'generate', prompts: THREE, aspect_ratio: '16:9' },
      output: batch(
        [
          [FOX, '1024x1024', THREE[0]!],
          ['/workspace/output/images/hare.png', '1024x1536', THREE[2]!],
        ],
        [{ prompt: THREE[1]!, error: 'Image generation failed (500): Upstream error.' }],
      ),
    });
    const tiles = tilesOf(html);
    expect(tiles[0]!.tag).toContain('col-span-2');
    expect(tiles[1]!.body).toContain('Upstream error.');
    expect(tiles[2]!.body).not.toContain('Upstream error.');
  });

  test('no action toolbar renders at rest', () => {
    blob = { blobUrl: 'blob:fox', blob: null, isLoading: false, error: null };
    try {
      for (const html of [
        render({ status: 'completed', output: batch([[FOX, '1024x1024', 'a']]) }),
        render({ status: 'completed', input: { action: 'generate', prompts: ['a', 'b'] }, output: batch([[FOX, '1024x1024', 'a'], ['/workspace/output/images/b.png', '1024x1024', 'b']]) }),
      ]) {
        expect(html).not.toContain('Preview<');
        expect(html).not.toContain('aria-label="Refresh"');
        expect(html).not.toContain('aria-label="Full screen"');
        // The one corner hint shows on hover only.
        expect(html).toMatch(/data-image-gen-expand=""[^>]*class="[^"]*opacity-0[^"]*group-hover:opacity-100/);
      }
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
    }
  });

  test('clicking a tile opens full screen', async () => {
    blob = { blobUrl: 'blob:fox', blob: null, isLoading: false, error: null };
    useKortixComputerStore.getState().setIsExpanded(false);
    try {
      const output = batch([[FOX, '1024x1024', 'a fox'], ['/workspace/output/images/b.png', '1024x1024', 'b owl']]);
      await inDom({ status: 'completed', input: { action: 'generate', prompts: ['a fox', 'b owl'] }, output }, async (container) => {
        const tile = container.querySelector('button[aria-label="Open full screen: a fox"]') as HTMLButtonElement | null;
        expect(tile).not.toBeNull();
        await act(async () => tile?.click());
      });
      expect(useFilePreviewStore.getState().filePath).toBe(FOX);
      expect(useKortixComputerStore.getState().isExpanded).toBe(true);
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
      useKortixComputerStore.getState().setIsExpanded(false);
      useFilePreviewStore.setState({ isOpen: false, filePath: null, lineNumber: undefined, captions: {} });
    }
  });

  test('the card renders no prompt or model text', () => {
    const prompts = ['A fox in a shuttle', 'An owl in a shuttle'];
    const states = [
      render({ status: 'running', input: { action: 'generate', prompts } }),
      render({ status: 'running', input: { action: 'generate', prompts: [prompts[0]] } }),
      render({
        status: 'completed',
        input: { action: 'generate', prompts },
        output: batch([[FOX, '1024x1024', prompts[0]!]], [{ prompt: prompts[1]!, error: 'Image generation failed (500): Upstream error.' }], 'google/gemini-2.5-flash-image'),
      }),
      render({ status: 'error', input: { action: 'generate', prompts }, error: 'Image generation failed (500): Upstream error.' }),
      render({ status: 'error', input: { action: 'generate', prompts }, error: 'The operation was aborted.' }),
    ];
    for (const html of states) {
      const text = visibleText(html);
      for (const prompt of prompts) expect(text).not.toContain(prompt);
      expect(text).not.toContain('gemini');
      expect(html).not.toContain('font-mono');
    }
  });

  test('opening an image passes its prompt and model to the full-screen view', async () => {
    blob = { blobUrl: 'blob:fox', blob: null, isLoading: false, error: null };
    try {
      const output = batch([[FOX, '1024x1024', 'A fox in a shuttle']], [], 'codex/gpt-image-2');
      await inDom({ status: 'completed', input: { action: 'generate', prompts: ['A fox in a shuttle'] }, output }, async (container) => {
        const open = container.querySelector('button[aria-label="Open full screen: A fox in a shuttle"]') as HTMLButtonElement | null;
        expect(open).not.toBeNull();
        await act(async () => open?.click());
      });
      expect(useFilePreviewStore.getState().filePath).toBe(FOX);
      expect(useFilePreviewStore.getState().captions['output/images/fox.png']).toEqual({ text: 'A fox in a shuttle', model: 'codex/gpt-image-2' });
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
      useFilePreviewStore.setState({ isOpen: false, filePath: null, lineNumber: undefined, captions: {} });
    }
  });

  test('a batch with one failure shows two images and one error', () => {
    const html = render({
      status: 'completed',
      input: { action: 'generate', prompts: THREE, aspect_ratio: '1:1' },
      output: batch(
        [
          [FOX, '1024x1024', THREE[0]!],
          ['/workspace/output/images/hare.jpg', '1536x1024', THREE[2]!],
        ],
        [{ prompt: THREE[1]!, error: 'Image generation failed (400): The request was refused. Change the prompt, then retry. [content_policy]' }],
      ),
    });
    expect(tilesOf(html)).toHaveLength(3);
    expect(count(html, 'The request was refused.')).toBe(1);
    expect(html).toContain('Change the prompt, then retry.');
    expect(html).not.toContain('content_policy');
  });

  test('a failed frame with a ChatGPT code offers the ChatGPT reconnect for its card', () => {
    const html = render({
      status: 'completed',
      input: { action: 'generate', prompts: ['a', 'b'] },
      output: batch([[FOX, '1024x1024', 'a']], [{ prompt: 'b', error: 'Image generation failed (401): The ChatGPT login expired. Reconnect ChatGPT in Models, then retry. [provider_reauth_required]' }]),
    });
    expect(count(html, 'data-chatgpt-slot="reconnect"')).toBe(1);
    expect(html).not.toContain('Connect model');
    expect(html).toContain('The ChatGPT login expired.');
  });

  test('two failed frames that need a connection show the action once for the card', () => {
    const unavailable = 'Image generation failed (400): No image model is available for this project. Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings. [image_model_unavailable]';
    const html = render({
      status: 'completed',
      input: { action: 'generate', prompts: ['a', 'b', 'c'] },
      output: batch([[FOX, '1024x1024', 'a']], [{ prompt: 'b', error: unavailable }, { prompt: 'c', error: unavailable }]),
    });
    expect(count(html, 'No image model is available for this project.')).toBe(2);
    expect(count(html, 'Connect model')).toBe(1);
  });

  test('a ready grid frame whose file is still loading shows its loading state', () => {
    const html = render({
      status: 'completed',
      input: { action: 'generate', prompts: ['a', 'b'] },
      output: batch([[FOX, '1024x1024', 'a'], ['/workspace/output/images/b.png', '1024x1024', 'b']]),
    });
    expect(count(html, 'aria-busy="true"')).toBe(2);
    expect(count(html, 'Loading image')).toBe(2);
    expect(count(html, 'role="status"')).toBe(2);
  });

  test('legacy single path output still renders', () => {
    const html = render({
      status: 'completed',
      input: { action: 'generate', prompt: 'A paper-cutout fox', size: '1536x1024' },
      output: JSON.stringify({ path: FOX, action: 'generate', size: '1254x836', model: 'gpt-image-2' }),
    });
    expect(html).toContain('Loading image');
    expect(html).toContain('aspect-ratio:3 / 2');
    expect(bentoOf(html)).toBeNull();
  });

  test('a failure shows the gateway message and suggestion', () => {
    const html = render({ status: 'error', error: 'Image limit reached. Try again in 2 hours.' });
    expect(html).toContain('Image limit reached.');
    expect(html).toContain('Try again in 2 hours.');
    expect(html).not.toContain('aria-busy');
  });

  test('a stopped call says Stopped with no sheen', () => {
    const html = render({ status: 'error', error: 'The operation was aborted.' });
    expect(html).toContain('Stopped');
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('Generating image');
  });

  const COMPLETED = { status: 'completed', output: batch([[FOX, '1536x1024', 'A paper-cutout fox']]) };

  test('a waking sandbox (readiness 503) keeps the card loading, not failed', () => {
    blob = { blobUrl: null, blob: null, isLoading: false, error: 'Sandbox not ready (503): the sandbox is starting' };
    try {
      const html = render(COMPLETED);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('Loading image');
      expect(html).not.toContain('Sandbox not ready');
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
    }
  });

  test('a runtime-not-ready error keeps the tile loading', () => {
    // An older session whose sandbox is stopped: the runtime URL is not pinned yet.
    blob = { blobUrl: null, blob: null, isLoading: false, error: '[kortix-runtime] Server URL not ready — sandbox is still loading' };
    try {
      for (const html of [render(COMPLETED), render({ status: 'completed', input: { prompts: THREE }, output: batch(THREE.map((p, i) => [`/workspace/output/images/${i}.png`, '1024x1024', p])) })]) {
        expect(html).toContain('aria-busy="true"');
        expect(html).toContain('Loading image');
        expect(html).not.toContain('Server URL not ready');
        expect(html).not.toContain('kortix-runtime');
        expect(html).not.toContain('Image unavailable');
      }
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
    }
  });

  // Replaces "a real read error is shown in the frame" (R38, Jay 2026-10-28): a tile never shows raw error text.
  test('a real load failure shows Image unavailable with retry, never the raw message', () => {
    blob = { blobUrl: null, blob: null, isLoading: false, error: 'Failed to read file (500): internal stack detail' };
    try {
      const html = render(COMPLETED);
      expect(html).toContain('Image unavailable');
      expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
      expect(html).not.toContain('internal stack detail');
      expect(html).not.toContain('aria-busy="true"');
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
    }
  });

  test('a path the file API cannot read shows the path, not an endless loading frame', () => {
    const html = render({ status: 'completed', output: batch([['C:\\images\\fox.png', '1024x1024', 'A paper-cutout fox']]) });
    expect(html).toContain('fox.png');
    expect(html).not.toContain('Loading image');
  });

  test('a rate limit names the reset time in words, never the raw seconds or the code', () => {
    const html = render({
      status: 'error',
      error: 'Image generation failed (429): The ChatGPT image limit is reached. Wait for the limit to reset, then retry. Retry after 7200 s. [image_rate_limited]',
    });
    expect(html).toContain('The ChatGPT image limit is reached.');
    expect(html).toContain('Try again in 2 hours.');
    expect(html).not.toContain('7200');
    expect(html).not.toContain('image_rate_limited');
  });

  test('a JPEG loads in the frame like a PNG, at its delivered ratio', () => {
    const html = render({
      status: 'completed',
      output: batch([['/workspace/output/images/fox.jpg', '1344x768', 'A paper-cutout fox']], [], 'google/gemini-2.5-flash-image'),
    });
    expect(html).toContain('Loading image');
    expect(html).toContain('aspect-ratio:7 / 4');
  });

  const UNAVAILABLE = {
    status: 'error',
    error:
      'Image generation failed (400): No image model is available for this project. Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings. [image_model_unavailable]',
  };

  test('image_model_unavailable shows Connect model, which opens the project model settings on Providers', async () => {
    opened.length = 0;
    await inDom(UNAVAILABLE, async (container) => {
      expect(container.textContent).toContain('No image model is available for this project.');
      expect(container.textContent).toContain('Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.');
      expect(container.textContent).not.toContain('image_model_unavailable');
      expect(container.querySelector('[data-provider-modal]')).not.toBeNull();
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Connect model');
      expect(button).toBeDefined();
      await act(async () => button?.click());
    });
    expect(opened).toEqual(['providers']);
  });

  const NOT_CONNECTED = 'Image generation failed (400): Connect Codex to use this model. Connect your ChatGPT account in Models, then retry. [provider_not_connected]';
  const REAUTH = 'Image generation failed (401): The ChatGPT login expired. Reconnect ChatGPT in Models, then retry. [provider_reauth_required]';

  test('the ChatGPT codes use the session error banner\'s ChatGPT fix, not Connect model', () => {
    const notConnected = render({ status: 'error', error: NOT_CONNECTED });
    expect(notConnected).toContain('data-chatgpt-slot="connect"');
    expect(notConnected).not.toContain('Connect model');
    const reauth = render({ status: 'error', error: REAUTH });
    expect(reauth).toContain('data-chatgpt-slot="reconnect"');
    expect(reauth).not.toContain('Connect model');
  });

  test('the ChatGPT fix shows only when ChatGPT failed; another provider\'s key failure shows Connect model (R37)', () => {
    const refused = (provider: string, code: string) =>
      render({ status: 'error', error: `Image generation failed (401): ${provider} refused the credential. Check the ${provider} key in project settings, then retry. [provider:${provider}] [${code}]` });
    for (const provider of ['openai', 'google', 'xai', 'openrouter']) {
      for (const code of ['provider_reauth_required', 'provider_not_connected']) {
        const html = refused(provider, code);
        expect(html).not.toContain('data-chatgpt-slot');
        expect(count(html, 'Connect model')).toBe(1);
      }
    }
    expect(refused('openai-codex', 'provider_reauth_required')).toContain('data-chatgpt-slot="reconnect"');
    expect(refused('openai-codex', 'provider_not_connected')).toContain('data-chatgpt-slot="connect"');
    expect(refused('openai-codex', 'provider_not_connected')).not.toContain('Connect model');
    // A text from before the provider token: ChatGPT only when it names ChatGPT or Codex.
    const legacyKey = render({ status: 'error', error: 'Image generation failed (401): openai refused the credential. Check the openai key in project settings, then retry. [provider_reauth_required]' });
    expect(legacyKey).not.toContain('data-chatgpt-slot');
    expect(count(legacyKey, 'Connect model')).toBe(1);
  });

  test('a read-only view offers no fix at all', () => {
    readOnly = true;
    try {
      for (const error of [NOT_CONNECTED, REAUTH, UNAVAILABLE.error]) {
        const html = render({ status: 'error', error });
        expect(html).not.toContain('data-chatgpt-slot');
        expect(html).not.toContain('Connect model');
      }
    } finally {
      readOnly = false;
    }
  });

  test('Connect model is hidden in a shared session and for a member without project.model.write', () => {
    sessionRow = { visibility: 'project', created_by: VIEWER };
    try {
      expect(render(UNAVAILABLE)).not.toContain('Connect model');
    } finally {
      sessionRow = { visibility: 'private', created_by: VIEWER };
    }
    sessionRow = { visibility: 'private', created_by: 'another-member' };
    try {
      expect(render(UNAVAILABLE)).not.toContain('Connect model');
    } finally {
      sessionRow = { visibility: 'private', created_by: VIEWER };
    }
    canWriteProviders = false;
    try {
      const html = render(UNAVAILABLE);
      expect(html).toContain('No image model is available for this project.');
      expect(html).not.toContain('Connect model');
    } finally {
      canWriteProviders = true;
    }
  });

  test('a refusal a connection cannot fix, or a viewer without model settings, shows no Connect model', () => {
    expect(render({ status: 'error', error: 'Image generation failed (400): gpt-6 cannot make images. [not_an_image_model]' })).not.toContain('Connect model');
    canConnectProvider = false;
    try {
      const html = render(UNAVAILABLE);
      expect(html).toContain('No image model is available for this project.');
      expect(html).not.toContain('Connect model');
    } finally {
      canConnectProvider = true;
    }
  });

  test('an open call on a turn that ended is stopped; on a live turn it is generating', () => {
    expect(render({ status: 'running' }, { live: false })).toContain('Stopped');
    expect(render({ status: 'running' }, { live: true })).toContain('Generating image');
    // Outside a transcript turn the call's own status decides.
    expect(render({ status: 'running' })).toContain('Generating image');
  });
});

describe('one grid per turn (R38)', () => {
  /** One image_gen call of `n` prompts, running, or completed with every image in. */
  function genCall(id: string, n: number, done = false, ratio = '1:1') {
    const prompts = Array.from({ length: n }, (_, i) => `${id} prompt ${i}`);
    return toolCallBlock({
      type: 'tool',
      tool: 'image_gen',
      callID: id,
      id,
      state: {
        status: done ? 'completed' : 'running',
        input: { action: 'generate', prompts, aspect_ratio: ratio },
        ...(done && { output: batch(prompts.map((prompt, i) => [`/workspace/output/images/${id}-${i}.png`, '1024x1024', prompt])) }),
        time: { start: Date.now() - 5_000 },
      },
    } as unknown as ToolPart);
  }
  /** The run's first call, drawn in a live turn with the run in context. */
  function renderRun(calls: ReturnType<typeof genCall>[]) {
    const runs = new Map(calls.map((one) => [one.id, calls]));
    return renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <QueryClientProvider client={new QueryClient()}>
          <InTranscriptTurnContext.Provider value>
            <TurnLiveContext.Provider value>
              <ImageGenRunsContext.Provider value={runs}>
                <ImageGenTool call={calls[0]!} />
              </ImageGenRunsContext.Provider>
            </TurnLiveContext.Provider>
          </InTranscriptTurnContext.Provider>
        </QueryClientProvider>
      </IntlTestProvider>,
    );
  }
  const gridStyleOf = (html: string) => /data-image-gen-grid="[^"]+"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? '';
  const SPACING = 0.23 * 16;
  /** A CSS length expression in px, for a `column`-px-wide figure in a `viewport`-px-tall window. */
  function px(expr: string, column: number, viewport: number): number {
    const js = expr
      .replaceAll('var(--spacing)', String(SPACING))
      .replaceAll('100cqw', String(column))
      .replaceAll('60vh', String(0.6 * viewport))
      .replaceAll('calc(', '(')
      .replaceAll('min(', 'Math.min(');
    return Function(`return ${js}`)() as number;
  }
  /** The grid's rows (its track heights) and its width, in px. */
  function layoutOf(html: string, column: number, viewport: number) {
    const style = gridStyleOf(html);
    const rows = /grid-template-rows:(.*?);/.exec(style)![1]!.match(/calc\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g)!;
    const width = /width:(min\(.*\))$/.exec(style)![1]!;
    return { tracks: rows.map((row) => px(row, column, viewport)), width: px(width, column, viewport) };
  }
  const placesOf = (html: string) => tilesOf(html).map((tile) => /style="([^"]*)"/.exec(tile.tag)?.[1] ?? '');
  const gridOf = (html: string) => /data-image-gen-grid="([^"]+)"/.exec(html)?.[1] ?? null;

  test('two consecutive image_gen calls render one grid of five', () => {
    const html = renderRun([genCall('space', 3, true), genCall('apples', 2)]);
    expect(gridOf(html)).toBe('3+2');
    expect(tilesOf(html)).toHaveLength(5);
    // The first row is the three-bento: one large tile, two stacked; the second row two side by side.
    expect(placesOf(html)).toEqual([
      'grid-column:1 / span 4;grid-row:1 / span 2',
      'grid-column:5 / span 2;grid-row:1',
      'grid-column:5 / span 2;grid-row:2',
      'grid-column:1 / span 3;grid-row:3',
      'grid-column:4 / span 3;grid-row:3',
    ]);
    // The generating call keeps its own busy line in its first tile; the done call's images load.
    expect(count(html, 'Generating 2 images')).toBe(1);
    expect(count(html, 'aria-busy="true"')).toBe(5);
    // Each row is its own rectangle: a 1.5 row and a 2 row of square tiles, as wide as the 1.5 row allows.
    expect(gridStyleOf(html)).toContain('width:min(100cqw, 60vh * 1.5)');
  });

  test('six images are two rows of three: 3+3', () => {
    const html = renderRun([genCall('a', 3), genCall('b', 3)]);
    expect(gridOf(html)).toBe('3+3');
    expect(placesOf(html)).toEqual([
      'grid-column:1 / span 4;grid-row:1 / span 2',
      'grid-column:5 / span 2;grid-row:1',
      'grid-column:5 / span 2;grid-row:2',
      'grid-column:1 / span 4;grid-row:3 / span 2',
      'grid-column:5 / span 2;grid-row:3',
      'grid-column:5 / span 2;grid-row:4',
    ]);
  });

  test('seven images are three, then two, then two: 3+2+2', () => {
    const html = renderRun([genCall('a', 3), genCall('b', 2), genCall('c', 2)]);
    expect(gridOf(html)).toBe('3+2+2');
    expect(placesOf(html).slice(3)).toEqual([
      'grid-column:1 / span 3;grid-row:3',
      'grid-column:4 / span 3;grid-row:3',
      'grid-column:1 / span 3;grid-row:4',
      'grid-column:4 / span 3;grid-row:4',
    ]);
  });

  test('eight images are two 2×2 rows: 4+4, no row taller than the cap', () => {
    const html = renderRun([genCall('a', 4, false, '9:16'), genCall('b', 4, false, '9:16')]);
    expect(gridOf(html)).toBe('4+4');
    expect(placesOf(html)).toEqual([
      'grid-column:1 / span 3;grid-row:1',
      'grid-column:4 / span 3;grid-row:1',
      'grid-column:1 / span 3;grid-row:2',
      'grid-column:4 / span 3;grid-row:2',
      'grid-column:1 / span 3;grid-row:3',
      'grid-column:4 / span 3;grid-row:3',
      'grid-column:1 / span 3;grid-row:4',
      'grid-column:4 / span 3;grid-row:4',
    ]);
    // Each 2×2 row of 9:16 tiles is 9:16; the grid's width keeps each at most 60vh tall.
    expect(gridStyleOf(html)).toContain('width:min(100cqw, 60vh * 0.5625)');
    const { tracks } = layoutOf(html, 720, 480);
    // Two 2×2 rows: each row is two tracks and a gap, at most 60vh (288 px) tall.
    expect(tracks[0]! + SPACING + tracks[1]!).toBeLessThanOrEqual(288 + 1e-9);
  });

  test('a tile keeps its frame while the run grows: tiles are keyed by call and place', async () => {
    // Two calls of two are one bento of four; a third call makes it 3+3 in the same grid element.
    const four = renderRun([genCall('a', 2), genCall('b', 2)]);
    expect(bentoOf(four)).toEqual({ count: 4, ratio: 1 });
    const six = renderRun([genCall('a', 2), genCall('b', 2), genCall('c', 2)]);
    expect(gridOf(six)).toBe('3+3');
    expect(tilesOf(six)).toHaveLength(6);
  });

  test('a failed call in a run keeps one slot per prompt', () => {
    const failed = toolCallBlock({
      type: 'tool',
      tool: 'image_gen',
      callID: 'f',
      id: 'f',
      state: { status: 'error', input: { prompts: ['x', 'y'] }, error: 'Image generation failed (500): Upstream error.', time: { start: 1 } },
    } as unknown as ToolPart);
    const html = renderRun([genCall('a', 3), failed]);
    expect(gridOf(html)).toBe('3+2');
    expect(tilesOf(html).slice(3).every((tile) => tile.body.includes('Upstream error.'))).toBe(true);
  });

  test('the merged grid is exactly the sum of its rows: no aspect ratio, no min height, no empty band', () => {
    // Jay's turn: three 16:9 space images, then two 16:9 apples. The old fr rows (factors summing to 0.66)
    // left a third of the box empty under the last row.
    const html = renderRun([genCall('space', 3, false, '16:9'), genCall('apples', 2, false, '16:9')]);
    const style = gridStyleOf(html);
    expect(style).not.toContain('aspect-ratio');
    expect(style).not.toContain('min-height');
    expect(style).not.toContain('fr');
    for (const [column, viewport] of [[720, 900], [720, 480], [360, 800]] as const) {
      const { tracks, width } = layoutOf(html, column, viewport);
      const r = 16 / 9;
      // Row 1 (three-bento, 1.5r) is two tracks and one gap; row 2 (two side by side, 2r) one track.
      const row1 = tracks[0]! + SPACING + tracks[1]!;
      const row2 = tracks[2]!;
      expect(tracks).toHaveLength(3);
      expect(row1).toBeCloseTo(width / (1.5 * r));
      expect(row2).toBeCloseTo(width / (2 * r));
      // The grid's height is the rows plus the gaps between tracks: nothing else.
      const height = tracks.reduce((sum, track) => sum + track, 0) + SPACING * (tracks.length - 1);
      expect(height).toBeCloseTo(row1 + SPACING + row2);
      // No row is taller than the cap, and the grid is never wider than the column.
      expect(Math.max(row1, row2)).toBeLessThanOrEqual(0.6 * viewport + 1e-9);
      expect(width).toBeLessThanOrEqual(column);
    }
    // The figure is the inline-size container the rows measure.
    expect(html).toMatch(/<figure class="[^"]*@container/);
  });
});
