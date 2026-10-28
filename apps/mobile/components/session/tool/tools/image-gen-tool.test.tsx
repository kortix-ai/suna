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
  'imageGen.loading': 'Loading image',
  'imageGen.stopped': 'Stopped',
  'imageGen.failed': 'The image was not generated.',
  'imageGen.retryHour': 'Try again in {{count}} hours.',
  'imageGen.notLoaded': 'The image did not load.',
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
let imagePhase: 'load' | 'error' = 'load';
mock.module('@/components/session/turn/use-sandbox-image', () => ({
  useSandboxImage: (path: string) => ({
    phase: imagePhase,
    source: { uri: `sandbox:${path}` },
    sizeBytes: null,
    attempt: 0,
    loadAnyway: () => {},
    handleError: () => {},
  }),
}));
const TurnLiveContext = React.createContext(false);
mock.module('../shared/infrastructure', () => ({
  TurnLiveContext,
  isLocalSandboxFilePath: (path: string) => path.startsWith('/workspace/'),
  useToolNavigation: () => ({ openFile: () => {}, openExternal: () => {} }),
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
  test('a running call shows the busy label, the time since the call started, and the prompt', async () => {
    await render(call({ status: 'running' }), true);
    expect(texts()).toContain('Generating image');
    expect(texts()).toContain('0:42');
    expect(texts()).toContain('A paper-cutout fox');
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

  test('a ready card names the model that made the image, a JPEG loads like a PNG', async () => {
    const output = batch([['/workspace/output/images/fox.jpg', '1344x768', 'A paper-cutout fox']], [], 'google/gemini-2.5-flash-image');
    await render(call({ status: 'completed', output }), false);
    expect(texts()).toContain('A paper-cutout fox');
    expect(texts()).toContain('google/gemini-2.5-flash-image');
    const images = tree?.root.findAll((node) => node.type === 'image') ?? [];
    expect(images[0]!.props.source).toEqual({ uri: 'sandbox:/workspace/output/images/fox.jpg', headers: undefined });
  });

  test('a three-prompt call shows three generating frames under one busy line', async () => {
    await render(call({ status: 'running', input: { action: 'generate', prompts: THREE, aspect_ratio: '16:9' } }), true);
    const ratios = frameRatios();
    expect(ratios).toHaveLength(3);
    for (const ratio of ratios) expect(ratio).toBeCloseTo(16 / 9);
    expect(texts().filter((t) => t === 'Generating 3 images')).toHaveLength(1);
    expect(texts().filter((t) => t === '0:42')).toHaveLength(1);
    expect(texts()).not.toContain('Generating image');
    for (const prompt of THREE) expect(texts()).toContain(prompt);
  });

  test('a batch with one failure shows two images and one error, each in its place', async () => {
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
    // The frames keep the order the call asked for; the model caption is once, last.
    const at = (text: string) => all.indexOf(text);
    expect(at(THREE[0]!) < at('The request was refused.') && at('The request was refused.') < at(THREE[2]!)).toBe(true);
    expect(all.filter((t) => t === 'codex/gpt-image-2')).toHaveLength(1);
    expect(all.at(-1)).toBe('codex/gpt-image-2');
  });

  test('legacy single path output still renders', async () => {
    const output = JSON.stringify({ path: FOX, action: 'generate', size: '1254x836', model: 'gpt-image-2' });
    await render(call({ status: 'completed', input: { action: 'generate', prompt: 'A paper-cutout fox', size: '1536x1024' }, output }), false);
    const images = tree?.root.findAll((node) => node.type === 'image') ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]!.props.source).toEqual({ uri: `sandbox:${FOX}`, headers: undefined });
    expect(texts()).toContain('A paper-cutout fox');
    expect(texts()).toContain('gpt-image-2');
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

  test('a load that keeps failing says so after the retries, and Try again starts over', async () => {
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
    expect(texts()).toContain('The image did not load.');
    const retry = tree?.root.findAll((node) => node.type === 'button') ?? [];
    expect(retry).toHaveLength(1);
    imagePhase = 'load';
    await act(async () => (retry[0]!.props.onPress as () => void)());
    expect(texts()).not.toContain('The image did not load.');
    expect(tree?.root.findAll((node) => node.type === 'image')).toHaveLength(1);
  });
});
