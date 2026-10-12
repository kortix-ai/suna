/**
 * `UserMessageEditor` keeps a sent message's attachments (KRTX-962): a tile
 * and a remove dot per attachment, Send carries the kept ones, and an
 * edit still needs text. Native modules and leaf
 * UI primitives are mocked; the editor's own state runs for real.
 */
import { beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { MessageAttachment } from '@/lib/session/user-message';

const tiles: string[] = [];
const tileProps: any[] = [];
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
  // The trigger renders its children: a pastes-only message's tiles sit inside it.
  ContextMenu: passthrough('rn-context-menu'),
  ContextMenuContent: Empty,
  ContextMenuItem: Empty,
  ContextMenuLabel: Empty,
  ContextMenuSeparator: Empty,
  ContextMenuTrigger: ({ children }: any) => React.createElement('rn-context-menu-trigger', null, children),
}));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: Empty }));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({}) }));
mock.module('@/components/icons/slack-icon', () => ({ SlackIcon: Empty }));
mock.module('@/components/icons/teams-icon', () => ({ TeamsIcon: Empty }));
mock.module('@/components/icons/telegram-icon', () => ({ TelegramIcon: Empty }));
mock.module('@/components/session/ParticipantAvatar', () => ({ ParticipantAvatar: Empty }));
mock.module('@/components/session/mention-chip', () => ({ MentionChip: Empty }));
mock.module('@/lib/icons', () => ({
  AlarmIcon: Empty,
  CheckIcon: Empty,
  CopyIcon: Empty,
  LightningIcon: Empty,
  PencilIcon: Empty,
  TextTIcon: Empty,
  DownloadSimpleIcon: Empty,
  PaperPlaneTiltIcon: Empty,
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/kortix/KortixLogo', () => ({ KortixLogo: Empty }));
mock.module('@/components/session/turn/source-pill', () => ({ SourcePill: Empty }));
mock.module('@/components/kortix/sheet', () => ({ CopyContentButton: Empty, KortixBottomSheetModal: Empty }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetScrollView: Empty }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
mock.module('@/lib/haptics', () => ({ haptics: { medium: () => {}, selection: () => {}, success: () => {} } }));
mock.module('@/lib/utils/theme', () => ({
  MOTION: { duration: { slow: 300 }, easing: { default: [0, 0, 1, 1] } },
  THEME: { light: { muted: '#m', sidebar: '#s', mutedForeground: '#mf', foreground: '#f' }, dark: {} },
  withAlpha: (color: string) => color,
}));
mock.module('@/components/session/turn/use-sandbox-image', () => ({
  useSandboxImage: () => ({ phase: 'idle', source: null }),
}));
mock.module('@/components/session/attachment-tile', () => ({
  AttachmentTile: (props: any) => {
    const { filename } = props;
    tiles.push(filename);
    tileProps.push(props);
    return null;
  },
  AttachmentOverflowTile: Empty,
  AttachmentRemoveButton: ({ filename, onRemove }: any) => {
    removeButtons[filename] = onRemove;
    return null;
  },
}));

let UserMessageEditor: typeof import('./user-message').UserMessageEditor;
let UserMessage: typeof import('./user-message').UserMessage;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ UserMessageEditor, UserMessage } = await import('./user-message'));
});
beforeEach(() => {
  tiles.length = 0;
  tileProps.length = 0;
  for (const key of Object.keys(removeButtons)) delete removeButtons[key];
});

const attachments: MessageAttachment[] = [
  { key: 'u0', filename: 'a.png', mime: 'image/png', src: '/w/a.png', path: '/w/a.png' },
  { key: 'f1', filename: 'b.pdf', mime: 'application/pdf', src: 'https://example.test/b.pdf' },
];

function sendButton(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => (node.type as string) === 'rn-button').at(-1)!;
}

async function mount(
  initialText: string,
  onSend: (text: string, kept: MessageAttachment[]) => void,
  files: MessageAttachment[] = attachments,
) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <UserMessageEditor isDark={false} initialText={initialText} attachments={files} onCancel={() => {}} onSend={onSend} />,
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

test('an edit with no text cannot send, even with attachments kept', async () => {
  // A text-less replacement prompt does not commit the staged rewind: the
  // runtime keeps the original turn and appends a new one (KRTX-962 preview).
  const sent: Array<[string, string[]]> = [];
  const tree = await mount('   ', (text, kept) => sent.push([text, kept.map((file) => file.key)]));
  expect(tiles).toEqual(['a.png', 'b.pdf']);
  expect(sendButton(tree).props.disabled).toBe(true);
  await act(async () => sendButton(tree).props.onPress());
  expect(sent).toEqual([]);
});

test('a kept paste is a removable tile, and is text enough to send; removed, the edit needs text again', async () => {
  // Synthetic paste only.
  const paste: MessageAttachment = { key: 'pasted:0a1b2c3d', filename: 'Pasted text', pasted: { id: '0a1b2c3d', text: 'synthetic' } };
  const sent: Array<[string, string[]]> = [];
  const tree = await mount('', (text, kept) => sent.push([text, kept.map((file) => file.key)]), [paste]);
  expect(tiles).toEqual(['Pasted text']);
  expect(sendButton(tree).props.disabled).toBe(false);
  await act(async () => sendButton(tree).props.onPress());
  expect(sent).toEqual([['', ['pasted:0a1b2c3d']]]);

  await act(async () => removeButtons['Pasted text']!());
  expect(sendButton(tree).props.disabled).toBe(true);
});

test('a pastes-only message: its tile is inside the menu trigger, tap opens the paste, long press opens the menu', async () => {
  const { serializePromptWithPastes } = await import('@kortix/shared');
  const text = serializePromptWithPastes('', [{ id: '0a1b2c3d', text: 'synthetic' }]);
  const turn = {
    userMessage: { info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', id: 'p1', text }] },
    assistantMessages: [],
  } as any;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<UserMessage turn={turn} isDark={false} onEditStart={() => {}} />);
  });
  expect(tiles).toEqual(['Pasted text']);
  expect(typeof tileProps[0].onPress).toBe('function');
  expect(typeof tileProps[0].onLongPress).toBe('function');
  expect(tree.root.findAll((node) => (node.type as string) === 'rn-context-menu-trigger')).toHaveLength(1);
});
