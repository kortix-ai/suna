/**
 * The Keep current plan confirm dialog of ScheduledDowngradeCard. It names the
 * current plan, disables both buttons and relabels to "Keeping plan…" while
 * the cancel request runs, refuses to close while pending, and shows a failure
 * in place with the confirm button re-enabled.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

const rows: Array<{ label?: string; onPress?: () => void }> = [];
const hapticCalls: string[] = [];
const cancelled: number[] = [];

// The cancel mutation, driven by the test like the real hook: the caller
// passes onSuccess/onError into mutate(); isPending tracks the request.
const cancelChange = {
  isPending: false,
  mutate: (_vars: unknown, options?: { onSuccess?: () => void; onError?: () => void }) => {
    cancelChange.isPending = true;
    cancelChange.settle = (ok: boolean) => {
      cancelChange.isPending = false;
      if (ok) options?.onSuccess?.();
      else options?.onError?.();
    };
  },
  settle: undefined as ((ok: boolean) => void) | undefined,
};

mock.module('react-native', () => ({
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
  View: host('view'),
  StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('react-native-reanimated', () => ({ default: { View: host('animated') } }));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('gh-scroll') }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetModal: none, BottomSheetView: host('bs-view') }));
mock.module('expo-linear-gradient', () => ({ LinearGradient: host('lg') }));
mock.module('@/lib/icons', () => ({ ArrowsLeftRightIcon: none, CalendarDotsIcon: none, ArrowUUpLeftIcon: none }));
mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children, ...props }: HostProps & { open?: boolean }) => (open ? React.createElement('alert-dialog', props, children) : null),
  AlertDialogContent: host('alert-content'),
  AlertDialogHeader: host('alert-header'),
  AlertDialogTitle: host('alert-title'),
  AlertDialogDescription: host('alert-description'),
  AlertDialogFooter: host('alert-footer'),
  AlertDialogCancel: ({ children, ...props }: HostProps) => React.createElement('alert-cancel', props, children),
}));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/kortix/settings-list', () => ({
  SettingsGroup: host('settings-group'),
  SettingsRow: ({ label, onPress, ...props }: HostProps & { label?: string; onPress?: () => void }) => {
    rows.push({ label, onPress });
    return React.createElement('settings-row', { label, ...props });
  },
}));
mock.module('@/contexts', () => ({ useLanguage: () => ({ t: (key: string, d?: string | Record<string, unknown>) => (typeof d === 'string' ? d : `${d?.defaultValue ?? ''}`.replaceAll('{{plan}}', String(d?.plan ?? '')).replaceAll('{{date}}', String(d?.date ?? ''))) }) }));
mock.module('@/lib/billing', () => ({ useCancelScheduledChange: () => cancelChange }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: () => hapticCalls.push('tap'), warning: () => hapticCalls.push('warning'), medium: () => hapticCalls.push('medium'), success: () => hapticCalls.push('success') } }));
mock.module('@/lib/logger', () => ({ log: { error: none, warn: none, info: none } }));
mock.module('@/lib/utils/theme', () => ({
  THEME: { light: {}, dark: {} },
  withAlpha: (c: string) => c,
  MOTION: { easing: { out: [0, 0, 1, 1] }, duration: { moderate: 200 } },
}));

let ScheduledDowngradeCard: typeof import('./ScheduledDowngradeCard').ScheduledDowngradeCard;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ScheduledDowngradeCard } = await import('./ScheduledDowngradeCard'));
});

const change = {
  type: 'downgrade',
  current_tier: { name: 'basic', display_name: 'Basic' },
  target_tier: { name: 'pro', display_name: 'Pro' },
  effective_date: '2026-03-01T00:00:00Z',
} as never;

let tree: ReactTestRenderer | undefined;
const renderIt = () =>
  act(() => {
    tree = create(<ScheduledDowngradeCard scheduledChange={change} onCancel={() => cancelled.push(1)} />);
  });
const rerenderIt = () =>
  act(() => {
    tree!.update(<ScheduledDowngradeCard scheduledChange={change} onCancel={() => cancelled.push(1)} />);
  });

const row = (label: string) => rows.find((r) => r.label === label) as { label?: string; onPress?: () => void } | undefined;
const texts = () =>
  (['text', 'alert-title', 'alert-description'] as const)
    .flatMap((type) => tree!.root.findAllByType(type as never))
    .map((n: { props: { children?: unknown } }) => String(n.props.children));
const buttonByLabel = (label: string) => {
  const found = tree!
    .root.findAllByType('button' as never)
    .find((b: { findAllByType: (t: never) => Array<{ props: { children?: unknown } }> }) =>
      b.findAllByType('text' as never).some((t) => String(t.props.children).includes(label)));
  expect(found).toBeTruthy();
  return found! as unknown as { props: { onPress?: () => void; disabled?: boolean } };
};

afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  rows.length = 0;
  hapticCalls.length = 0;
  cancelled.length = 0;
  cancelChange.isPending = false;
  cancelChange.settle = undefined;
});

describe('the ScheduledDowngradeCard keep-plan confirm dialog', () => {
  test('Keep current plan opens the dialog naming the plan and the change it cancels', () => {
    renderIt();
    act(() => row('Keep current plan')!.onPress!());
    expect(texts()).toContain('Keep Basic?');
    expect(texts()).toContain('The change to Pro on March 1, 2026 is cancelled.');
    expect(buttonByLabel('Keep plan'));
  });

  test('while the cancel runs both buttons disable, the label becomes "Keeping plan…", and the dialog refuses to close', () => {
    renderIt();
    act(() => row('Keep current plan')!.onPress!());
    expect(cancelChange.isPending).toBe(false);
    act(() => buttonByLabel('Keep plan').props.onPress!());
    expect(cancelChange.isPending).toBe(true);
    rerenderIt(); // the mock's isPending flip only shows on the next render
    expect(texts()).toContain('Keeping plan…');
    expect(buttonByLabel('Keeping plan…').props.disabled).toBe(true);
    expect(tree!.root.findByType('alert-cancel' as never).props.disabled).toBe(true);
    // Cancel while pending: the dialog's onOpenChange(false) is refused.
    act(() => tree!.root.findByType('alert-dialog' as never).props.onOpenChange!(false));
    expect(texts()).toContain('Keeping plan…');
    // The cancel succeeds: the dialog closes and the card reports the cancel.
    act(() => cancelChange.settle!(true));
    expect(texts()).not.toContain('Keeping plan…');
    expect(cancelled).toEqual([1]);
    expect(hapticCalls).toContain('success');
  });

  test('a failed cancel keeps the dialog open with the failure text and a re-enabled confirm', () => {
    renderIt();
    act(() => row('Keep current plan')!.onPress!());
    act(() => buttonByLabel('Keep plan').props.onPress!());
    act(() => cancelChange.settle!(false));
    expect(texts()).toContain('Could not cancel the change. Try again.');
    expect(buttonByLabel('Keep plan').props.disabled).toBe(false);
    // Retrying runs the mutation again.
    act(() => buttonByLabel('Keep plan').props.onPress!());
    expect(cancelChange.isPending).toBe(true);
  });
});
