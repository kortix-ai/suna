/**
 * The `image_gen` card's four states, rendered: generating (busy label and
 * elapsed time), failed (message without the `[code]` token, suggestion, the
 * retry wait), stopped (an open call on a finished turn), ready (the sandbox
 * image). Native surfaces are host stand-ins; `imageGenView` stays real.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
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
  'imageGen.loading': 'Loading image',
  'imageGen.stopped': 'Stopped',
  'imageGen.failed': 'The image was not generated.',
  'imageGen.retryHour': 'Try again in {{count}} hours.',
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
mock.module('@/components/session/turn/use-sandbox-image', () => ({
  useSandboxImage: (path: string) => ({
    phase: 'load',
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
});

const INPUT = { action: 'generate', prompt: 'A paper-cutout fox', size: '1536x1024' };

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
    const output = JSON.stringify({ path: '/workspace/output/images/fox.png', action: 'generate', size: '1254x836', model: 'gpt-image-2' });
    await render(call({ status: 'completed', output }), false);
    const images = tree?.root.findAll((node) => node.type === 'image') ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]!.props.source).toEqual({ uri: 'sandbox:/workspace/output/images/fox.png', headers: undefined });
    expect(texts()).toContain('Loading image');
  });
});
