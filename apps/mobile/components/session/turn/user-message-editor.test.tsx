/**
 * `UserMessageEditor` keeps a sent message's attachments (KRTX-962): a tile
 * and a remove dot per attachment, Send carries the kept ones, and an
 * attachment-only edit can send, as in the composer. Native modules and leaf
 * UI primitives are mocked; the editor's own state runs for real.
 */
import { beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { MessageAttachment } from '@/lib/session/user-message';

const tiles: string[] = [];
const removeButtons: Record<string, () => void> = {};

const passthrough =
  (host: string) =>
  ({ children, ...props }: any) =>
    React.createElement(host, props, children);
const Empty = () => null;

mock.module('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default },
  Pressable: passthrough('rn-pressable'),
  TextInput: passthrough('rn-text-input'),
  View: passthrough('rn-view'),
}));
mock.module('react-native-reanimated', () => ({
  default: { View: passthrough('rn-animated-view') },
  Easing: { bezier: () => ({}) },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withTiming: () => ({}),
}));
mock.module('expo-linear-gradient', () => ({ LinearGradient: Empty }));
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }));
mock.module('@/components/ui/text', () => ({ Text: passthrough('rn-text') }));
mock.module('@/components/ui/button', () => ({ Button: passthrough('rn-button') }));
mock.module('@/components/ui/icon', () => ({ Icon: Empty }));
mock.module('@/components/ui/context-menu', () => ({
  ContextMenu: Empty,
  ContextMenuContent: Empty,
  ContextMenuItem: Empty,
  ContextMenuLabel: Empty,
  ContextMenuSeparator: Empty,
  ContextMenuTrigger: Empty,
}));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: Empty }));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({}) }));
mock.module('@/components/icons/slack-icon', () => ({ SlackIcon: Empty }));
mock.module('@/components/session/ParticipantAvatar', () => ({ ParticipantAvatar: Empty }));
mock.module('@/components/session/mention-chip', () => ({ MentionChip: Empty }));
mock.module('@/lib/icons', () => ({
  CaretDownIcon: Empty,
  CopyIcon: Empty,
  PencilIcon: Empty,
  TextTIcon: Empty,
  DownloadSimpleIcon: Empty,
  PaperPlaneTiltIcon: Empty,
  TimerIcon: Empty,
}));
mock.module('@/lib/haptics', () => ({ haptics: { medium: () => {} } }));
mock.module('@/lib/utils/theme', () => ({
  MOTION: { duration: { slow: 300 }, easing: { default: [0, 0, 1, 1] } },
  THEME: { light: { muted: '#m', sidebar: '#s', mutedForeground: '#mf', foreground: '#f' }, dark: {} },
  withAlpha: (color: string) => color,
}));
mock.module('@/components/session/turn/use-sandbox-image', () => ({
  useSandboxImage: () => ({ phase: 'idle', source: null }),
}));
mock.module('@/components/session/attachment-tile', () => ({
  AttachmentTile: ({ filename }: any) => {
    tiles.push(filename);
    return null;
  },
  AttachmentOverflowTile: Empty,
  AttachmentRemoveButton: ({ filename, onRemove }: any) => {
    removeButtons[filename] = onRemove;
    return null;
  },
}));

let UserMessageEditor: typeof import('./user-message').UserMessageEditor;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ UserMessageEditor } = await import('./user-message'));
});
beforeEach(() => {
  tiles.length = 0;
  for (const key of Object.keys(removeButtons)) delete removeButtons[key];
});

const attachments: MessageAttachment[] = [
  { key: 'u0', filename: 'a.png', mime: 'image/png', src: '/w/a.png', path: '/w/a.png' },
  { key: 'f1', filename: 'b.pdf', mime: 'application/pdf', src: 'https://example.test/b.pdf' },
];

function sendButton(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => (node.type as string) === 'rn-button').at(-1)!;
}

async function mount(initialText: string, onSend: (text: string, kept: MessageAttachment[]) => void) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <UserMessageEditor isDark={false} initialText={initialText} attachments={attachments} onCancel={() => {}} onSend={onSend} />,
    );
  });
  return tree;
}

test('shows a tile and a remove control per attachment; Send carries the kept ones', async () => {
  const sent: Array<[string, string[]]> = [];
  const tree = await mount('edit me', (text, kept) => sent.push([text, kept.map((file) => file.key)]));
  expect(tiles).toEqual(['a.png', 'b.pdf']);
  expect(Object.keys(removeButtons)).toEqual(['a.png', 'b.pdf']);

  await act(async () => removeButtons['a.png']!());
  await act(async () => sendButton(tree).props.onPress());
  expect(sent).toEqual([['edit me', ['f1']]]);
});

test('an attachment-only edit can send; with no text and no attachment it cannot', async () => {
  const sent: Array<[string, string[]]> = [];
  const tree = await mount('', (text, kept) => sent.push([text, kept.map((file) => file.key)]));
  expect(sendButton(tree).props.disabled).toBe(false);

  await act(async () => removeButtons['a.png']!());
  await act(async () => removeButtons['b.pdf']!());
  expect(sendButton(tree).props.disabled).toBe(true);
  await act(async () => sendButton(tree).props.onPress());
  expect(sent).toEqual([]);
});
