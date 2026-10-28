/**
 * The `image_gen` card's four states, rendered: generating (busy label,
 * elapsed time, the requested aspect ratio), failed (message without the
 * `[code]` token, suggestion, the retry wait), stopped (an open call on a
 * finished turn), ready (the sandbox image and the model that made it).
 * Native surfaces are host stand-ins; `imageGenView` stays real.
 */

import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { toolCallBlock, type ToolCallBlock, type ToolPart } from '@kortix/sdk';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const Text = ({ children }: HostProps) => React.createElement('text', null, children);

mock.module('react-native', () => ({
  View: host('view'),
  Image: host('image'),
  Pressable: host('pressable'),
  StyleSheet: { absoluteFill: {} },
  // A 720×480 window: the image box is at most 60% of 480 = 288 pt tall.
  useWindowDimensions: () => ({ width: 720, height: 480, scale: 1, fontScale: 1 }),
}));
mock.module('react-native-reanimated', () => ({
  default: { View: host('view') },
  Easing: { out: () => () => 0, cubic: () => 0 },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withTiming: (value: unknown) => value,
}));
const EN: Record<string, string> = {
  'imageGen.generating': 'Generating image',
  'imageGen.editing': 'Editing image',
  'imageGen.generatingCount': 'Generating {{count}} images',
  'imageGen.editingCount': 'Editing {{count}} images',
  'imageGen.openFullScreen': 'Open full screen',
  'imageGen.openFullScreenPrompt': 'Open full screen: {{prompt}}',
  'imageGen.loading': 'Loading image',
  'imageGen.stopped': 'Stopped',
  'imageGen.failed': 'The image was not generated.',
  'imageGen.retryHour': 'Try again in {{count}} hours.',
  'imageGen.unavailable': 'Image unavailable',
  'common.retry': 'Try again',
};
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      (EN[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name])),
  }),
}));
mock.module('@/components/ui/text', () => ({ Text }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/kortix/text-shimmer', () => ({ TextShimmer: Text }));
mock.module('@/components/session/dot-matrix/session-dot-matrix', () => ({ SessionDotMatrix: () => null }));
mock.module('@/components/session/dot-matrix/use-reduce-motion', () => ({ useReduceMotion: () => false }));
/** What every `useSandboxImage` mount reports: `error` stands for a load the native loader gave up on. */
let imagePhase: 'probing' | 'load' | 'error' = 'load';
mock.module('@/components/session/turn/use-sandbox-image', () => ({
  useSandboxImage: (path: string) => ({
    phase: imagePhase,
    source: { uri: `sandbox:${path}` },
    sizeBytes: null,
    attempt: 0,
    loadAnyway: () => {},
    handleError: () => {},
  }),
  useSandboxUrl: () => 'https://sandbox.example',
}));
const TurnLiveContext = React.createContext(false);
const ImageGenRunsContext = React.createContext<ReadonlyMap<string, ToolCallBlock[]>>(new Map());
/** Every `openFile(path, line, caption)` the card made. */
const opened: unknown[][] = [];
mock.module('../shared/infrastructure', () => ({
  TurnLiveContext,
  ImageGenRunsContext,
  isLocalSandboxFilePath: (path: string) => path.startsWith('/workspace/'),
  useToolNavigation: () => ({ openFile: (...args: unknown[]) => opened.push(args), openExternal: () => {} }),
}));
mock.module('../shared/registry', () => ({ ToolRegistry: { register: () => {} } }));
mock.module('../shared/styles', () => ({
  TURN_SPACE: { gap2: 8, radiusMd: 8 },
  TURN_TYPE: { xs: {} },
  monoFont: 'mono',
  useTurnPalette: () => ({ muted: '#eee', foreground: '#000', mutedForeground: '#777' }),
}));

let ImageGenTool: typeof import('./image-gen-tool').ImageGenTool;
let tree: ReactTestRenderer | undefined;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ImageGenTool } = await import('./image-gen-tool'));
});

afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
  imagePhase = 'load';
  jest.useRealTimers();
});

const INPUT = { action: 'generate', prompts: ['A paper-cutout fox'], aspect_ratio: '3:2' };
const THREE = ['A fox in a shuttle', 'An owl in a shuttle', 'A hare in a shuttle'];
const FOX = '/workspace/output/images/fox.png';

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

const bento = () => tree?.root.findAll((node) => node.type === 'view' && node.props.testID === 'image-gen-bento')[0];
type Node = NonNullable<typeof tree>['root'];
/** The nearest host `view` above a node (a mocked `View` is a component around its host element). */
function hostParent(node: Node): Node | null {
  let up = node.parent;
  while (up && up.type !== 'view') up = up.parent;
  return up;
}
/** The bento's tiles, by slot. */
const tiles = () =>
  (tree?.root.findAll((node) => node.type === 'view' && /^image-gen-tile-\d$/.test(String(node.props.testID ?? ''))) ?? []).sort(
    (a, b) => String(a.props.testID).localeCompare(String(b.props.testID)),
  );

/** Every frame's `aspectRatio`, in render order. */
function frameRatios(): number[] {
  return (tree?.root.findAll((node) => node.type === 'view' && (node.props.style as { aspectRatio?: number } | undefined)?.aspectRatio !== undefined) ?? [])
    .map((node) => (node.props.style as { aspectRatio: number }).aspectRatio);
}

function call(state: Record<string, unknown>): ToolCallBlock {
  return toolCallBlock({
    type: 'tool',
    tool: 'image_gen',
    callID: 'call-img-1',
    id: 'prt-img-1',
    messageID: 'msg-1',
    sessionID: 'ses-1',
    state: { time: { start: Date.now() - 42_000 }, input: INPUT, ...state },
  } as unknown as ToolPart);
}

async function render(block: ToolCallBlock, live: boolean) {
  await act(async () => {
    tree = create(
      <TurnLiveContext.Provider value={live}>
        <ImageGenTool call={block} />
      </TurnLiveContext.Provider>,
    );
  });
}

function texts(): string[] {
  return (tree?.root.findAll((node) => node.type === 'text') ?? []).map((node) =>
    ([] as unknown[]).concat(node.props.children).join(''),
  );
}

describe('ImageGenTool', () => {
  test('a running call shows the busy label and the time since the call started', async () => {
    await render(call({ status: 'running' }), true);
    expect(texts()).toContain('Generating image');
    expect(texts()).toContain('0:42');
    expect(tree?.root.findAll((node) => node.type === 'image')).toHaveLength(0);
  });

  test('a rate-limit failure shows the message without its code, the suggestion and the wait', async () => {
    await render(
      call({
        status: 'error',
        error:
          'Image generation failed (429): The ChatGPT image limit is reached. Wait for the limit to reset, then retry. Retry after 7200 s. [image_rate_limited]',
      }),
      false,
    );
    expect(texts()).toContain('The ChatGPT image limit is reached.');
    expect(texts()).toContain('Wait for the limit to reset, then retry.');
    expect(texts()).toContain('Try again in 2 hours.');
    expect(texts().some((t) => t.includes('[image_rate_limited]'))).toBe(false);
  });

  test('an open call on a finished turn reads Stopped, not generating', async () => {
    await render(call({ status: 'running' }), false);
    expect(texts()).toContain('Stopped');
    expect(texts()).not.toContain('Generating image');
  });

  test('a completed call loads the sandbox image', async () => {
    const output = batch([[FOX, '1254x836', 'A paper-cutout fox']]);
    await render(call({ status: 'completed', output }), false);
    const images = tree?.root.findAll((node) => node.type === 'image') ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]!.props.source).toEqual({ uri: 'sandbox:/workspace/output/images/fox.png', headers: undefined });
    expect(texts()).toContain('Loading image');
  });

  test('the generating frame holds the requested aspect ratio', async () => {
    await render(call({ status: 'running' }), true);
    const frame = tree?.root.findAll((node) => node.type === 'view' && (node.props.style as { aspectRatio?: number } | undefined)?.aspectRatio !== undefined) ?? [];
    expect((frame[0]!.props.style as { aspectRatio: number }).aspectRatio).toBe(1.5);
  });

  test('aspect_ratio 16:9 holds a 16:9 frame; a legacy size still sets the frame', async () => {
    const ratio = () =>
      (tree?.root.findAll((node) => node.type === 'view' && (node.props.style as { aspectRatio?: number } | undefined)?.aspectRatio !== undefined)[0]!
        .props.style as { aspectRatio: number }).aspectRatio;
    await render(call({ status: 'running', input: { ...INPUT, aspect_ratio: '16:9' } }), true);
    expect(ratio()).toBeCloseTo(16 / 9);
    await act(async () => tree?.unmount());
    await render(call({ status: 'running', input: { action: 'generate', prompt: 'x', size: '1024x1536' } }), true);
    expect(ratio()).toBeCloseTo(2 / 3);
  });

  test('a JPEG loads like a PNG', async () => {
    const output = batch([['/workspace/output/images/fox.jpg', '1344x768', 'A paper-cutout fox']], [], 'google/gemini-2.5-flash-image');
    await render(call({ status: 'completed', output }), false);
    const images = tree?.root.findAll((node) => node.type === 'image') ?? [];
    expect(images[0]!.props.source).toEqual({ uri: 'sandbox:/workspace/output/images/fox.jpg', headers: undefined });
  });

  test('a three-prompt call shows three generating tiles, one busy line in the first', async () => {
    await render(call({ status: 'running', input: { action: 'generate', prompts: THREE, aspect_ratio: '16:9' } }), true);
    expect(tiles()).toHaveLength(3);
    expect(texts().filter((t) => t === 'Generating 3 images')).toHaveLength(1);
    expect(texts().filter((t) => t === '0:42')).toHaveLength(1);
    expect(texts()).not.toContain('Generating image');
  });

  test('three images render one large left tile and two stacked right tiles', async () => {
    const input = { action: 'generate', prompts: THREE, aspect_ratio: '3:2' };
    const shape = () => ({
      ratio: (bento()!.props.style as { aspectRatio: number }).aspectRatio,
      flex: tiles().map((tile) => (tile.props.style as { flex: number }).flex),
      stacked: hostParent(tiles()[1]!) === hostParent(tiles()[2]!) && (hostParent(tiles()[1]!)!.props.style as { flexDirection?: string }).flexDirection !== 'row',
    });
    await render(call({ status: 'running', input }), true);
    const running = shape();
    // One rectangle from the requested 3:2: the left tile is 2/3 wide and two rows tall (1.5 × 3/2).
    expect(running).toEqual({ ratio: 2.25, flex: [2, 1, 1], stacked: true });
    await act(async () => tree?.unmount());
    const output = batch([
      [FOX, '1024x1024', THREE[0]!],
      ['/workspace/output/images/owl.png', '1024x1536', THREE[1]!],
      ['/workspace/output/images/hare.png', '1536x1024', THREE[2]!],
    ]);
    await render(call({ status: 'completed', input, output }), false);
    // The same slots once the images land; each image crops to its tile.
    expect(shape()).toEqual(running);
    expect(tiles()[0]!.findAll((node) => node.type === 'image').map((image) => (image.props.source as { uri: string }).uri)).toEqual([`sandbox:${FOX}`]);
    expect(tree?.root.findAll((node) => node.type === 'image').every((image) => image.props.resizeMode === 'cover')).toBe(true);
  });

  test('two and four images fill the rectangle', async () => {
    await render(call({ status: 'running', input: { action: 'generate', prompts: ['a', 'b'], aspect_ratio: '3:2' } }), true);
    expect((bento()!.props.style as { aspectRatio: number }).aspectRatio).toBe(3);
    expect(tiles().map((tile) => (tile.props.style as { flex: number }).flex)).toEqual([1, 1]);
    await act(async () => tree?.unmount());
    await render(call({ status: 'running', input: { action: 'generate', prompts: ['a', 'b', 'c', 'd'], aspect_ratio: '1:1' } }), true);
    expect((bento()!.props.style as { aspectRatio: number }).aspectRatio).toBe(1);
    expect(tiles()).toHaveLength(4);
    expect(hostParent(tiles()[0]!)).toBe(hostParent(tiles()[1]!));
    expect(hostParent(tiles()[2]!)).toBe(hostParent(tiles()[3]!));
    expect(hostParent(tiles()[0]!)).not.toBe(hostParent(tiles()[2]!));
    await act(async () => tree?.unmount());
    // One image is a single frame at its own ratio, no rectangle.
    await render(call({ status: 'completed', output: batch([[FOX, '1024x1024', 'a']]) }), false);
    expect(bento()).toBeUndefined();
  });

  test('a lone 9:16 at a 720×480 window is at most 288 pt tall, and so is every rectangle', async () => {
    // The box narrows (`maxWidth`) to keep its ratio: never cropped more, never letterboxed.
    const heightIn = (style: { aspectRatio: number; maxWidth: number }, column: number) => Math.min(column, style.maxWidth) / style.aspectRatio;
    await render(call({ status: 'running', input: { action: 'generate', prompts: ['a'], aspect_ratio: '9:16' } }), true);
    const frame = tree?.root.findAll((node) => node.type === 'view' && node.props.accessibilityState?.busy === true)[0]!;
    expect(heightIn(frame.props.style, 720)).toBeCloseTo(288);
    await act(async () => tree?.unmount());
    for (const prompts of [['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']]) {
      await render(call({ status: 'running', input: { action: 'generate', prompts, aspect_ratio: '9:16' } }), true);
      expect(heightIn(bento()!.props.style, 720)).toBeLessThanOrEqual(288 + 1e-9);
      await act(async () => tree?.unmount());
    }
  });

  test('a tile names its full-screen action', async () => {
    const output = batch([[FOX, '1024x1024', 'a fox'], ['/workspace/output/images/b.png', '1024x1024', 'b owl']]);
    await render(call({ status: 'completed', input: { action: 'generate', prompts: ['a fox', 'b owl'] }, output }), false);
    const labels = tree?.root.findAll((node) => (node.type as string) === 'pressable').map((node) => node.props.accessibilityLabel);
    expect(labels).toEqual(['Open full screen: a fox', 'Open full screen: b owl']);
  });

  test('no action toolbar renders at rest', async () => {
    const output = batch([[FOX, '1024x1024', 'a'], ['/workspace/output/images/b.png', '1024x1024', 'b']]);
    await render(call({ status: 'completed', input: { action: 'generate', prompts: ['a', 'b'] }, output }), false);
    expect(tree?.root.findAll((node) => node.type === 'button')).toHaveLength(0);
  });

  test('clicking a tile opens full screen', async () => {
    opened.length = 0;
    const output = batch([[FOX, '1024x1024', 'a fox'], ['/workspace/output/images/b.png', '1024x1024', 'b owl']], [], 'codex/gpt-image-2');
    await render(call({ status: 'completed', input: { action: 'generate', prompts: ['a fox', 'b owl'] }, output }), false);
    const tap = tiles()[1]!.findAll((node) => (node.type as string) === 'pressable')[0]!;
    await act(async () => (tap.props.onPress as () => void)());
    expect(opened).toEqual([['/workspace/output/images/b.png', undefined, { text: 'b owl', model: 'codex/gpt-image-2' }]]);
  });

  test('the busy line wraps in a narrow tile, and only the first tile is announced', async () => {
    await render(call({ status: 'running', input: { action: 'generate', prompts: THREE } }), true);
    const rows = tree?.root.findAll((node) => node.type === 'view' && (node.props.style as { flexWrap?: string } | undefined)?.flexWrap === 'wrap') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.findAll((node) => node.type === 'text').map((node) => ([] as unknown[]).concat(node.props.children).join(''))).toContain('Generating 3 images');
    const hidden = tree?.root.findAll((node) => node.type === 'view' && node.props.importantForAccessibility === 'no-hide-descendants') ?? [];
    expect(hidden).toHaveLength(2);
  });

  test('the card renders no prompt or model text', async () => {
    const prompts = ['A fox in a shuttle', 'An owl in a shuttle'];
    const states = [
      call({ status: 'running', input: { action: 'generate', prompts } }),
      call({ status: 'running', input: { action: 'generate', prompts: [prompts[0]] } }),
      call({
        status: 'completed',
        input: { action: 'generate', prompts },
        output: batch([[FOX, '1024x1024', prompts[0]!]], [{ prompt: prompts[1]!, error: 'Image generation failed (500): Upstream error.' }], 'google/gemini-2.5-flash-image'),
      }),
      call({ status: 'error', input: { action: 'generate', prompts }, error: 'Image generation failed (500): Upstream error.' }),
      call({ status: 'error', input: { action: 'generate', prompts }, error: 'The operation was aborted.' }),
    ];
    for (const block of states) {
      await render(block, block.status === 'running');
      const all = texts().join('\n');
      for (const prompt of prompts) expect(all).not.toContain(prompt);
      expect(all).not.toContain('gemini');
      await act(async () => tree?.unmount());
      tree = undefined;
    }
  });

  test('opening an image passes its prompt and model to the full-screen view', async () => {
    opened.length = 0;
    const output = batch([[FOX, '1024x1024', 'A fox in a shuttle']], [], 'codex/gpt-image-2');
    await render(call({ status: 'completed', input: { action: 'generate', prompts: ['A fox in a shuttle'] }, output }), false);
    const open = tree?.root.findAll((node) => (node.type as string) === 'pressable')[0];
    await act(async () => (open!.props.onPress as () => void)());
    expect(opened).toEqual([[FOX, undefined, { text: 'A fox in a shuttle', model: 'codex/gpt-image-2' }]]);
  });

  test('a batch with one failure shows two images and one error, each in its slot', async () => {
    const output = batch(
      [
        [FOX, '1024x1024', THREE[0]!],
        ['/workspace/output/images/hare.webp', '1536x1024', THREE[2]!],
      ],
      [{ prompt: THREE[1]!, error: 'Image generation failed (400): The request was refused. Change the prompt, then retry. [content_policy]' }],
    );
    await render(call({ status: 'completed', input: { action: 'generate', prompts: THREE }, output }), false);
    const images = tree?.root.findAll((node) => node.type === 'image') ?? [];
    expect(images.map((image) => (image.props.source as { uri: string }).uri)).toEqual([
      `sandbox:${FOX}`,
      'sandbox:/workspace/output/images/hare.webp',
    ]);
    const all = texts();
    expect(all.filter((t) => t === 'The request was refused.')).toHaveLength(1);
    expect(all).toContain('Change the prompt, then retry.');
    expect(all.some((t) => t.includes('content_policy'))).toBe(false);
    expect(all).not.toContain('codex/gpt-image-2');
    expect(tiles()[1]!.findAll((node) => node.type === 'text').map((node) => ([] as unknown[]).concat(node.props.children).join(''))).toContain('The request was refused.');
  });

  test('a ready grid frame whose file is still loading shows its loading state', async () => {
    const output = batch([[FOX, '1024x1024', 'a'], ['/workspace/output/images/b.png', '1024x1024', 'b']]);
    await render(call({ status: 'completed', input: { action: 'generate', prompts: ['a', 'b'] }, output }), false);
    expect(texts().filter((t) => t === 'Loading image')).toHaveLength(2);
  });

  test('legacy single path output still renders', async () => {
    const output = JSON.stringify({ path: FOX, action: 'generate', size: '1254x836', model: 'gpt-image-2' });
    await render(call({ status: 'completed', input: { action: 'generate', prompt: 'A paper-cutout fox', size: '1536x1024' }, output }), false);
    const images = tree?.root.findAll((node) => node.type === 'image') ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]!.props.source).toEqual({ uri: `sandbox:${FOX}`, headers: undefined });
  });

  test('a running call names no model', async () => {
    await render(call({ status: 'running' }), true);
    expect(texts().some((t) => t.includes('/'))).toBe(false);
  });

  test('image_model_unavailable shows the message and suggestion, with no button', async () => {
    await render(
      call({
        status: 'error',
        error:
          'Image generation failed (400): No image model is available for this project. Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings. [image_model_unavailable]',
      }),
      false,
    );
    expect(texts()).toContain('No image model is available for this project.');
    expect(texts()).toContain('Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.');
    expect(texts().some((t) => t.includes('image_model_unavailable'))).toBe(false);
    expect(tree?.root.findAll((node) => node.type === 'button')).toHaveLength(0);
  });

  test('a runtime-not-ready error keeps the tile loading', async () => {
    // The sandbox origin is not pinned yet (an older session's stopped box): the loader stays probing.
    imagePhase = 'probing';
    await render(call({ status: 'completed', output: batch([[FOX, '1254x836', 'A paper-cutout fox']]) }), false);
    expect(texts()).toContain('Loading image');
    expect(texts().join(' ')).not.toMatch(/not ready|kortix-runtime|Image unavailable/);
  });

  // "a load that keeps failing says so after the retries" said "The image did not load."; R38 names it like web.
  test('a real load failure shows Image unavailable with retry, never the raw message', async () => {
    jest.useFakeTimers();
    imagePhase = 'error';
    const output = batch([[FOX, '1254x836', 'A paper-cutout fox']]);
    await render(call({ status: 'completed', output }), false);
    expect(texts()).toContain('Loading image');
    for (let i = 0; i < 21; i++) {
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });
    }
    expect(texts()).toContain('Image unavailable');
    expect(texts()).not.toContain('The image did not load.');
    const retry = tree?.root.findAll((node) => node.type === 'button') ?? [];
    expect(retry).toHaveLength(1);
    imagePhase = 'load';
    await act(async () => (retry[0]!.props.onPress as () => void)());
    expect(texts()).not.toContain('Image unavailable');
    expect(tree?.root.findAll((node) => node.type === 'image')).toHaveLength(1);
  });
});

describe('one grid per turn (R38)', () => {
  function genCall(id: string, n: number, ratio = '1:1') {
    const prompts = Array.from({ length: n }, (_, i) => `${id} prompt ${i}`);
    return toolCallBlock({
      type: 'tool', tool: 'image_gen', callID: id, id, messageID: 'msg-1', sessionID: 'ses-1',
      state: { status: 'running', input: { action: 'generate', prompts, aspect_ratio: ratio }, time: { start: Date.now() - 5_000 } },
    } as unknown as ToolPart);
  }
  async function renderRun(calls: ToolCallBlock[]) {
    await act(async () => {
      tree = create(
        <TurnLiveContext.Provider value>
          <ImageGenRunsContext.Provider value={new Map(calls.map((one) => [one.id, calls]))}>
            <ImageGenTool call={calls[0]!} />
          </ImageGenRunsContext.Provider>
        </TurnLiveContext.Provider>,
      );
    });
  }
  const byTestId = (id: string) => tree?.root.findAll((node) => node.type === 'view' && node.props.testID === id)[0];
  /** Each row's tile count, top to bottom. */
  const rowCounts = () =>
    (tree?.root.findAll((node) => node.type === 'view' && /^image-gen-row-\d+$/.test(String(node.props.testID ?? ''))) ?? []).map(
      (row) => row.findAll((node) => node.type === 'view' && /^image-gen-tile-\d+$/.test(String(node.props.testID ?? ''))).length,
    );

  test('two consecutive image_gen calls render one grid of five', async () => {
    await renderRun([genCall('space', 3), genCall('apples', 2)]);
    expect(byTestId('image-gen-grid')).toBeDefined();
    expect(rowCounts()).toEqual([3, 2]);
    // Each call's first tile carries its own busy line.
    expect(texts().filter((text) => /^Generating \d images$/.test(text))).toEqual(['Generating 3 images', 'Generating 2 images']);
  });

  test('layout: 6 = 3+3, 7 = 3+2+2, 8 = 4+4', async () => {
    for (const [sizes, rows] of [[[3, 3], [3, 3]], [[3, 2, 2], [3, 2, 2]], [[4, 4], [4, 4]]] as const) {
      await renderRun(sizes.map((n, i) => genCall(`c${i}`, n)));
      expect(rowCounts()).toEqual([...rows]);
      await act(async () => tree?.unmount());
      tree = undefined;
    }
  });

  test('the merged grid is exactly the sum of its rows: no aspect ratio, no min height, every row under the cap', async () => {
    await renderRun([genCall('space', 3, '16:9'), genCall('apples', 2, '16:9')]);
    const column = byTestId('image-gen-grid')!.props.style as Record<string, number | string>;
    expect(column.aspectRatio).toBeUndefined();
    expect(column.minHeight).toBeUndefined();
    expect(column.height).toBeUndefined();
    const rows = [0, 1].map((row) => byTestId(`image-gen-row-${row}`)!.props.style as { aspectRatio: number; gap: number });
    const r = 16 / 9;
    expect(rows.map((row) => row.aspectRatio)).toEqual([1.5 * r, 2 * r]);
    // In a 720-pt column at a 480-pt window (cap 288): the column narrows to the tallest row's cap.
    const width = Math.min(720, column.maxWidth as number);
    const heights = rows.map((row) => width / row.aspectRatio);
    expect(Math.max(...heights)).toBeLessThanOrEqual(288 + 1e-9);
    // Rows + the one gap between them is the whole column: nothing else takes height.
    expect(column.gap).toBe(rows[0]!.gap);
  });
});

