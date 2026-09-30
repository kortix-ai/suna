import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

/**
 * Characterization test for the composer-card status pills above the chat
 * input (Jay, 2026-09-23): the card chrome is the composer card, exactly
 * (`components/kortix/composer.tsx`), and every pill draws the same wrapper,
 * card row, dot + label line and `secondary` `sm` action pills. The
 * assertions here pass before and after the shared `ComposerStatusPill`
 * extraction, so the refactor cannot drift the chrome.
 */

// Bun shares one module registry across the whole `bun test` process (see
// bunfig.toml → preload note), so this file must not mock a module another
// test file reads unmocked — `@/lib/utils/theme` especially: theme.test.ts
// pins the real THEME against global.css. The expected accent colors are
// therefore read from theme.ts's source instead of importing or mocking it.
const themeSource = readFileSync(import.meta.dir + '/../../lib/utils/theme.ts', 'utf8');
const accent = (name: 'orange' | 'yellow') => {
  const value = themeSource.match(new RegExp(`${name}: '([^']+)', // --kortix-${name}`))?.[1];
  expect(value).toBeDefined();
  return value!;
};
const ACCENT_ORANGE = accent('orange');
const ACCENT_YELLOW = accent('yellow');

const Pass = ({ children }: any) => children ?? null;
const AnimatedValue = class {
  interpolate(opts: any) {
    return { __interp: opts };
  }
};
const loopCounts = { started: 0, stopped: 0 };
const reactNative = {
  View: Pass,
  Text: Pass,
  Platform: { OS: 'android', select: (options: any) => options.android ?? options.native ?? options.default },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  Animated: {
    View: Pass,
    Value: AnimatedValue,
    loop: () => ({ start: () => loopCounts.started++, stop: () => loopCounts.stopped++ }),
    timing: (value: any, config: any) => ({ value, config }),
  },
  Easing: { out: (fn: (t: number) => number) => fn, quad: (t: number) => t },
};

// Pill inputs, overridden per test.
let wording: { label: string; tone: string } | null = null;
let reachability: { reachable: boolean; downSince: number | null; checked: boolean; connection: unknown } = {
  reachable: false,
  downSince: 1,
  checked: true,
  connection: 'failed',
};
let online = true;
let taps = 0;

mock.module('react-native', () => reactNative);
// The pills import the real `@/lib/utils/theme`, whose graph goes through
// expo-router's react-navigation barrel — the barrel needs a `Platform`, and
// the real react-native entry is unparsable for bun. Mock the barrel with
// the exact DefaultTheme/DarkTheme values it ships, the same stub
// lib/utils/theme.test.ts uses, so the real THEME evaluates and every
// consumer links against it.
mock.module('expo-router/react-navigation', () => ({
  DefaultTheme: {
    dark: false,
    colors: {
      primary: 'rgb(0, 122, 255)',
      background: 'rgb(242, 242, 242)',
      card: 'rgb(255, 255, 255)',
      text: 'rgb(28, 28, 30)',
      border: 'rgb(216, 216, 216)',
      notification: 'rgb(255, 59, 48)',
    },
    fonts: {},
  },
  DarkTheme: {
    dark: true,
    colors: {
      primary: 'rgb(10, 132, 255)',
      background: 'rgb(1, 1, 1)',
      card: 'rgb(18, 18, 18)',
      text: 'rgb(229, 229, 231)',
      border: 'rgb(39, 39, 41)',
      notification: 'rgb(255, 69, 58)',
    },
    fonts: {},
  },
  ThemeProvider: ({ children }: { children?: unknown }) => children,
  useFocusEffect: () => {},
  useIsFocused: () => true,
  useNavigation: () => ({}),
  StackActions: {},
  CommonActions: {},
}));
mock.module('@/lib/icons', () => ({
  ArrowsLeftRightIcon: Pass,
  WarningCircleIcon: Pass,
  ArrowClockwiseIcon: Pass,
}));
mock.module('@/components/ui/button', () => ({ Button: Pass }));
mock.module('@/components/ui/text', () => ({ Text: Pass }));
mock.module('@/components/ui/icon', () => ({ Icon: Pass }));
mock.module('@/contexts/SandboxContext', () => ({ useSandboxContext: () => ({ sandboxUrl: 'https://sandbox.test' }) }));
mock.module('@kortix/sdk', () => ({ sessionConnectionLabel: () => wording }));
mock.module('@/hooks/useSandboxReachability', () => ({
  useSandboxReachability: () => reachability,
  useElapsedSince: () => '53s',
}));
mock.module('@/lib/network/use-online-status', () => ({ useOnlineStatus: () => online }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: () => taps++ } }));

let SandboxHealthPill: typeof import('./SandboxHealthPill').SandboxHealthPill;
let LiveUpdatesPausedPill: typeof import('./LiveUpdatesPausedPill').LiveUpdatesPausedPill;
let ComposerStatusPill: typeof import('./ComposerStatusPill').ComposerStatusPill;
let ComposerStatusAction: typeof import('./ComposerStatusPill').ComposerStatusAction;

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  SandboxHealthPill = (await import('./SandboxHealthPill')).SandboxHealthPill;
  LiveUpdatesPausedPill = (await import('./LiveUpdatesPausedPill')).LiveUpdatesPausedPill;
  ComposerStatusPill = (await import('./ComposerStatusPill')).ComposerStatusPill;
  ComposerStatusAction = (await import('./ComposerStatusPill')).ComposerStatusAction;
});

let tree: ReactTestRenderer | undefined;
beforeEach(() => {
  loopCounts.started = 0;
  loopCounts.stopped = 0;
  taps = 0;
  online = true;
  wording = null;
  reachability = { reachable: false, downSince: 1, checked: true, connection: 'failed' };
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

async function render(element: React.ReactElement) {
  await act(async () => {
    tree = create(element);
  });
  return tree!;
}

const instances = (root: ReactTestRenderer, predicate: (node: ReactTestInstance) => boolean) =>
  root.root.findAll(predicate);

/** Every node whose className carries the exact chrome class list. */
const byClassName = (root: ReactTestRenderer, className: string) =>
  instances(root, (node) => typeof node.props.className === 'string' && node.props.className === className);

const WRAPPER = 'px-4 pb-2';
const CARD = 'flex-row items-center gap-2 rounded-3xl border border-border bg-background p-2';
const LABEL_ROW = 'flex-1 flex-row items-center gap-2 px-2';
const ACTION_PILL = 'rounded-full';

const actionPills = (root: ReactTestRenderer) =>
  instances(root, (node) => node.props.variant === 'secondary' && node.props.size === 'sm' && node.props.className === ACTION_PILL);

describe('SandboxHealthPill chrome', () => {
  test('a faulted computer draws the composer card with a pinging orange dot and both actions', async () => {
    wording = { label: "Can't reach computer", tone: 'danger' };
    const onHealth = () => {};
    const onSwitch = () => {};
    const root = await render(<SandboxHealthPill onHealth={onHealth} onSwitch={onSwitch} />);

    expect(byClassName(root, WRAPPER)).toHaveLength(1);
    expect(byClassName(root, CARD)).toHaveLength(1);
    expect(byClassName(root, LABEL_ROW)).toHaveLength(1);

    // The dot sits in the ping container: halo + dot, both ACCENT_ORANGE.
    const containers = instances(root, (node) => node.props.style?.width === 8 && node.props.style?.alignItems === 'center');
    expect(containers).toHaveLength(1);
    const halo = instances(root, (node) => node.props.style?.position === 'absolute' && node.props.style?.backgroundColor === ACCENT_ORANGE);
    expect(halo).toHaveLength(1);
    expect(halo[0].props.style.transform).toEqual([{ scale: halo[0].props.style.transform[0].scale }]);
    const dots = instances(root, (node) => node.props.style?.width === 8 && node.props.style?.borderRadius === 4);
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot.props.style.backgroundColor).toBe(ACCENT_ORANGE);

    // The ping loop runs while the pill is up.
    expect(loopCounts.started).toBe(1);

    // The SDK's wording plus the elapsed suffix, on the muted label line.
    const label = instances(root, (node) => node.props.variant === 'muted' && node.props.numberOfLines === 1);
    expect(label).toHaveLength(1);
    expect(label[0].props.className).toBe('shrink');
    expect(label[0].children[0]).toBe("Can't reach computer");
    const elapsed = label[0].children[1] as ReactTestInstance;
    expect(elapsed.props.className).toBe('opacity-60');
    expect(elapsed.children[0]).toBe(' · 53s');

    // Health and Switch are the composer's secondary sm pills with 14pt icons.
    const pills = actionPills(root);
    expect(pills).toHaveLength(2);
    expect(pills[0].props.onPress).toBe(onHealth);
    expect(pills[1].props.onPress).toBe(onSwitch);
    const pillText = (pill: ReactTestInstance) => (pill.children[1] as ReactTestInstance).children[0];
    for (const pill of pills) {
      expect(pill.children).toHaveLength(2);
      expect((pill.children[0] as ReactTestInstance).props.size).toBe(14);
    }
    expect(pillText(pills[0])).toBe('Health');
    expect(pillText(pills[1])).toBe('Switch');
  });

  test('a waking computer draws the same card in yellow with no actions', async () => {
    wording = { label: 'Waking computer', tone: 'progress' };
    const root = await render(<SandboxHealthPill onHealth={() => {}} onSwitch={() => {}} />);

    expect(byClassName(root, WRAPPER)).toHaveLength(1);
    expect(byClassName(root, CARD)).toHaveLength(1);
    const dots = instances(root, (node) => node.props.style?.width === 8 && node.props.style?.borderRadius === 4);
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot.props.style.backgroundColor).toBe(ACCENT_YELLOW);
    expect(actionPills(root)).toHaveLength(0);
  });

  test('a reachable computer hides the pill and mounts its slot instead', async () => {
    wording = { label: "Can't reach computer", tone: 'danger' };
    reachability = { reachable: true, downSince: null, checked: true, connection: 'connected' };
    const Parked = () => null;
    const root = await render(<SandboxHealthPill whenReachable={<Parked />} />);

    expect(byClassName(root, WRAPPER)).toHaveLength(0);
    expect(byClassName(root, CARD)).toHaveLength(0);
    expect(root.root.findAll((node) => node.type === Parked)).toHaveLength(1);
  });
});

describe('LiveUpdatesPausedPill chrome', () => {
  test('a paused stream draws the same composer card with the Reconnect action', async () => {
    wording = { label: "Can't reach computer", tone: 'danger' };
    let reconnects = 0;
    const root = await render(<LiveUpdatesPausedPill onReconnect={() => reconnects++} />);

    const wrapper = byClassName(root, WRAPPER);
    expect(wrapper).toHaveLength(1);
    expect(wrapper[0].props.accessibilityLiveRegion).toBe('polite');
    expect(byClassName(root, CARD)).toHaveLength(1);
    expect(byClassName(root, LABEL_ROW)).toHaveLength(1);

    // A still orange dot — one dot, no ping container.
    const dots = instances(root, (node) => node.props.style?.width === 8 && node.props.style?.borderRadius === 4);
    expect(dots).toHaveLength(1);
    expect(dots[0].props.style.backgroundColor).toBe(ACCENT_ORANGE);
    expect(loopCounts.started).toBe(0);

    const label = instances(root, (node) => node.props.variant === 'muted' && node.props.numberOfLines === 1);
    expect(label).toHaveLength(1);
    expect(label[0].children[0]).toBe('Live updates paused');

    const pills = actionPills(root);
    expect(pills).toHaveLength(1);
    expect(pills[0].props.accessibilityLabel).toBe('Reconnect live updates');
    expect((pills[0].children[0] as ReactTestInstance).props.size).toBe(14);
    expect((pills[0].children[1] as ReactTestInstance).children[0]).toBe('Reconnect');

    await act(async () => pills[0].props.onPress());
    expect(taps).toBe(1);
    expect(reconnects).toBe(1);
  });
});

describe('ComposerStatusPill chrome', () => {
  // The shared card, asserted once. The pill renders the wrapper, the card
  // row, the dot + label line and the composer's secondary sm action pill —
  // the chrome both pills above consume.
  test('renders the composer card once: wrapper, card row, dot, label, elapsed, action', async () => {
    const Do = () => null;
    const ping = { scale: { __interp: 'scale' } as never, opacity: { __interp: 'opacity' } as never };
    const root = await render(
      <ComposerStatusPill
        dotColor={ACCENT_ORANGE}
        ping={ping}
        label="Test status"
        elapsed="9s"
        accessibilityLiveRegion="polite"
        actions={
          <ComposerStatusAction
            icon={Pass as any}
            label="Do"
            accessibilityLabel="Do the thing"
            onPress={() => {}}
          />
        }
      />,
    );

    const wrapper = byClassName(root, WRAPPER);
    expect(wrapper).toHaveLength(1);
    expect(wrapper[0].props.accessibilityLiveRegion).toBe('polite');
    expect(byClassName(root, CARD)).toHaveLength(1);
    expect(byClassName(root, LABEL_ROW)).toHaveLength(1);

    const halo = instances(root, (node) => node.props.style?.position === 'absolute' && node.props.style?.backgroundColor === ACCENT_ORANGE);
    expect(halo).toHaveLength(1);
    const dots = instances(root, (node) => node.props.style?.width === 8 && node.props.style?.borderRadius === 4);
    expect(dots).toHaveLength(2);

    const label = instances(root, (node) => node.props.variant === 'muted' && node.props.numberOfLines === 1);
    expect(label).toHaveLength(1);
    expect(label[0].children[0]).toBe('Test status');
    const elapsed = label[0].children[1] as ReactTestInstance;
    expect(elapsed.props.className).toBe('opacity-60');
    expect(elapsed.children[0]).toBe(' · 9s');

    const pills = actionPills(root);
    expect(pills).toHaveLength(1);
    expect(pills[0].props.accessibilityLabel).toBe('Do the thing');
    expect((pills[0].children[0] as ReactTestInstance).props.size).toBe(14);
    expect((pills[0].children[1] as ReactTestInstance).children[0]).toBe('Do');
  });

  test('without ping it draws a still dot and no elapsed suffix', async () => {
    const root = await render(<ComposerStatusPill dotColor={ACCENT_YELLOW} label="Still" />);

    const dots = instances(root, (node) => node.props.style?.width === 8 && node.props.style?.borderRadius === 4);
    expect(dots).toHaveLength(1);
    expect(dots[0].props.style.backgroundColor).toBe(ACCENT_YELLOW);
    const label = instances(root, (node) => node.props.variant === 'muted' && node.props.numberOfLines === 1);
    expect(label[0].children).toHaveLength(1);
    expect(actionPills(root)).toHaveLength(0);
  });
});
