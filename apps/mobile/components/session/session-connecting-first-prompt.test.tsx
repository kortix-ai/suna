/**
 * The first prompt on the connecting view renders through the thread's own
 * `MessageBody`, so the bubble keeps one type from the project home send to
 * the live thread. A copied text style flashed a smaller size for a frame.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

const passthrough =
  (name: string) =>
  ({ children, ...props }: any) =>
    React.createElement(name, props, children);
const Empty = () => null;
const bodies: { text: string }[] = [];

mock.module('react-native', () => ({
  View: passthrough('rn-view'),
  ScrollView: passthrough('rn-scroll'),
  Text: passthrough('rn-text'),
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
mock.module('@kortix/sdk', () => ({ groupMessagesIntoTurns: () => [] }));
mock.module('@/lib/icons', () => ({ ArrowCounterClockwiseIcon: Empty }));
mock.module('@/components/ui/text', () => ({ Text: passthrough('ui-text') }));
mock.module('@/components/ui/button', () => ({ Button: passthrough('ui-button') }));
mock.module('@/components/ui/icon', () => ({ Icon: Empty }));
mock.module('@/components/kortix/composer', () => ({ COMPOSER_CARD_CLASS: '', Composer: Empty }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: Empty }));
mock.module('@/components/session/FloatingMenuButton', () => ({ FLOATING_MENU_CLEARANCE: 0 }));
mock.module('@/components/session/composer-bottom-fade', () => ({ ComposerBottomFade: Empty }));
mock.module('@/components/session/attachment-tile', () => ({ AttachmentTile: Empty }));
mock.module('@/components/session/turn/user-message', () => ({
  UserMessageBubble: passthrough('user-bubble'),
  MessageBody: (props: { text: string }) => {
    bodies.push(props);
    return React.createElement('message-body', props);
  },
}));
mock.module('@/components/session/SessionTurn', () => ({ SessionTurn: Empty }));
mock.module('@/components/session/dot-matrix/session-dot-matrix', () => ({ SessionDotMatrix: Empty }));
mock.module('@/components/session/tool/shared/navigation', () => ({
  ToolFilePreviewHost: Empty,
  useToolFilePreviewStore: () => undefined,
}));
mock.module('@/lib/projects/hooks', () => ({
  useSessionParticipants: () => ({ data: undefined }),
  useSessionMessageAuthors: () => ({ data: undefined }),
}));
mock.module('@/lib/session/participants', () => ({ messageAvatarPerson: () => null }));
mock.module('@/lib/session/auto-scroll', () => ({ turnTopGap: () => 0 }));
mock.module('@/lib/utils/theme', () => ({ THEME: { light: {}, dark: {}, accent: {} } }));
mock.module('@/lib/session/attachment-tile', () => ({ isPreviewableImage: () => false }));
mock.module('@/lib/session/user-message', () => ({ webSpace: (n: number) => n * 4 }));

let SessionConnecting: typeof import('./SessionConnecting').SessionConnecting;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SessionConnecting } = await import('./SessionConnecting'));
});

describe('SessionConnecting first prompt', () => {
  test('renders through the thread bubble’s MessageBody, not a copied text style', async () => {
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(<SessionConnecting firstMessage="Build the landing page" onCancel={() => {}} />);
    });
    expect(bodies.at(-1)).toMatchObject({ text: 'Build the landing page' });
    const bubble = tree!.root.findByType('user-bubble' as never);
    expect(bubble.findByType('message-body' as never).props.text).toBe('Build the landing page');
    await act(async () => tree!.unmount());
  });
});
