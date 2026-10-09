/**
 * Characterization of the composer's control row (the row the dedupe gave one
 * `ControlButton`): every icon control is `icon-md` + `rounded-full` with the
 * shared 4pt `hitSlop`, whatever its variant; the agent chip is the one `sm`
 * button and keeps only the `hitSlop`; the send button flips between the
 * ready and busy variants and shows the loader while sending.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

(globalThis as Record<string, unknown>).__DEV__ = true;

const buttons: Array<Record<string, unknown>> = [];
let tree: ReactTestRenderer | undefined;

mock.module('react-native', () => ({
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
  View: host('view'),
  TextInput: host('text-input'),
  StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('expo', () => ({ requireOptionalNativeModule: () => null }));
mock.module('expo-router', () => ({
  DarkTheme: { colors: {} },
  DefaultTheme: { colors: {} },
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, back: () => {}, replace: () => {} }),
}));
mock.module('expo-router/react-navigation', () => ({
  DarkTheme: { colors: {} },
  DefaultTheme: { colors: {} },
}));
mock.module('expo-blur', () => ({ BlurView: host('blur') }));
mock.module('expo-haptics', () => ({ impactAsync: () => {}, ImpactFeedbackStyle: { Light: 0, Medium: 1 } }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
const entering = { duration: () => entering, easing: () => entering, build: () => ({}) } as never;
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  Easing: { out: (f: unknown) => f, quad: (f: unknown) => f },
  FadeIn: entering,
  FadeOut: entering,
  LayoutAnimationConfig: ({ children }: HostProps) => children,
}));
mock.module('@/lib/icons', () => ({
  ArrowUpIcon: host('icon-arrow-up'),
  CaretDownIcon: host('icon-caret-down'),
  CheckIcon: host('icon-check'),
  MicrophoneIcon: host('icon-microphone'),
  PlusIcon: host('icon-plus'),
  XIcon: host('icon-x'),
}));
// The seam under test: what the row hands each `Button`.
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: HostProps) => {
    buttons.push(props);
    return React.createElement('button', props, children);
  },
}));
mock.module('@/components/ui/icon', () => ({ Icon: ({ as, ...props }: HostProps & { as?: unknown }) => React.createElement('icon', { icon: as?.name, ...props }) }));
mock.module('@/components/ui/text', () => ({ Text: host('text'), TextClassContext: React.Fragment }));
mock.module('@/components/kortix/pill-input', () => ({ INPUT_FONT_FAMILY: 'roobert', INPUT_FONT_SIZE: 16, PillInput: host('pill-input') }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: host('loader') }));
mock.module('@/components/kortix/dictation-waveform', () => ({ DictationWaveform: host('waveform') }));
mock.module('@/components/kortix/StopIcon', () => ({ StopIcon: host('icon-stop') }));
mock.module('@/components/session/composer-attachment-tiles', () => ({ ComposerAttachmentTiles: none }));
mock.module('@/hooks/useDictation', () => ({
  useDictation: () => ({
    active: false,
    state: 'idle',
    levels: [] as number[],
    start: () => {},
    cancel: () => {},
    finish: () => {},
  }),
}));

let Composer: typeof import('./composer').Composer;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ Composer } = await import('./composer'));
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  buttons.length = 0;
});

const render = (props: Record<string, unknown>) => {
  act(() => {
    tree = create(React.createElement(Composer as never, props as never));
  });
};

describe('composer control row', () => {
  const chip = { label: 'GPT-6.1 Sol', variant: 'secondary' as const };

  test('idle row: attach, chip and send, each icon control icon-md + rounded-full + hitSlop 4', () => {
    render({ value: '', onChangeText: () => {}, onSubmit: () => {}, onAttach: () => {}, chip, onChipPress: () => {} });
    const [attach, chipBtn, send] = buttons;
    for (const [name, btn] of [['attach', attach], ['send', send]] as const) {
      expect(btn.size).toBe('icon-md');
      expect(btn.className).toBe('rounded-full');
      expect(btn.hitSlop).toBe(4);
      expect(name).toBeTruthy();
    }
    // The chip is the row's only `sm` button; it shares just the hit slop.
    expect(chipBtn.size).toBe('sm');
    expect(chipBtn.hitSlop).toBe(4);
    expect(chipBtn.className).toContain('rounded-full');
    expect((chipBtn.className as string).includes('icon-md')).toBe(false);
  });

  test('send button: ready `default`, disabled `secondary`, in-flight renders the loader and stays disabled', () => {
    render({ value: 'hi', onChangeText: () => {}, onSubmit: () => {} });
    const send = buttons.at(-1)!;
    expect(send.variant).toBe('default');
    act(() => tree?.unmount());
    buttons.length = 0;
    render({ value: '', onChangeText: () => {}, onSubmit: () => {} });
    const idleSend = buttons.at(-1)!;
    expect(idleSend.variant).toBe('secondary');
    act(() => tree?.unmount());
    buttons.length = 0;
    render({ value: 'hi', onChangeText: () => {}, onSubmit: () => {}, sending: true });
    const sending = buttons.at(-1)!;
    expect(sending.disabled).toBe(true);
    const loader = tree!.root.findAll(n => (n.type as string) === 'loader');
    expect(loader.length).toBeGreaterThan(0);
  });

  test('busy row: Stop replaces Send until there is something to send', () => {
    render({ value: '', onChangeText: () => {}, onSubmit: () => {}, busy: true, onStop: () => {} });
    const stop = buttons.find(b => b.accessibilityLabel === 'Stop');
    expect(stop).toBeTruthy();
    expect(stop!.size).toBe('icon-md');
    expect(buttons.find(b => b.accessibilityLabel === 'Send')).toBeUndefined();
    act(() => tree?.unmount());
    buttons.length = 0;
    render({ value: 'reply', onChangeText: () => {}, onSubmit: () => {}, busy: true, onStop: () => {} });
    expect(buttons.find(b => b.accessibilityLabel === 'Stop')).toBeTruthy();
    const queuedSend = buttons.find(b => b.accessibilityLabel === 'Send');
    expect(queuedSend).toBeTruthy();
    expect(queuedSend!.size).toBe('icon-md');
  });

  test('dictation row: cancel and done are icon-md controls with the shared hit slop', () => {
    // Drive the dictation hook active for this test only.
    const dictation = {
      active: true,
      state: 'listening' as const,
      levels: [0.5],
      start: () => {},
      cancel: () => {},
      finish: () => {},
    };
    mock.module('@/hooks/useDictation', () => ({ useDictation: () => dictation }));
    render({ value: '', onChangeText: () => {}, onSubmit: () => {} });
    const cancel = buttons.find(b => b.accessibilityLabel === 'Cancel dictation');
    const done = buttons.find(b => b.accessibilityLabel === 'Done dictating');
    expect(cancel!.size).toBe('icon-md');
    expect(cancel!.hitSlop).toBe(4);
    expect(done!.size).toBe('icon-md');
    mock.module('@/hooks/useDictation', () => ({
      useDictation: () => ({ active: false, state: 'idle', levels: [], start: () => {}, cancel: () => {}, finish: () => {} }),
    }));
  });
});
