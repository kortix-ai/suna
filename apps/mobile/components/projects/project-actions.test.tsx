/**
 * The archive confirm dialog of ProjectActions. It opens after the action
 * sheet closes, shows the project name, disables both buttons and relabels to
 * "Archiving…" while the request runs, refuses to close while pending, and
 * shows a failure in place with the confirm button re-enabled.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

const rows: Array<{ label?: string; onPress?: () => void }> = [];
const buttons: Array<Record<string, unknown>> = [];
const toastSuccess: string[] = [];
const sheetOpen: number[] = [];

// The archive mutation, driven by the test: a deferred promise plus a
// mutable isPending the component reads on every render.
const archive = {
  isPending: false,
  deferred: undefined as { resolve: (v?: unknown) => void; reject: (e?: unknown) => void } | undefined,
  calls: 0,
  // Mirrors the real mutation hook: isPending tracks the in-flight request.
  mutateAsync: () => {
    archive.calls += 1;
    archive.isPending = true;
    return new Promise((resolve, reject) => {
      archive.deferred = {
        resolve: (v) => {
          archive.isPending = false;
          resolve(v);
        },
        reject: (e) => {
          archive.isPending = false;
          reject(e);
        },
      };
    });
  },
};

mock.module('react-native', () => ({
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
  View: host('view'),
  StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('react-native-reanimated', () => ({ default: { View: host('animated') } }));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('gh-scroll') }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetModal: none, BottomSheetView: host('bs-view') }));
mock.module('expo-linear-gradient', () => ({ LinearGradient: host('lg') }));
mock.module('@/lib/icons', () => ({ ArchiveIcon: none, FolderOpenIcon: none }));
mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children, ...props }: HostProps & { open?: boolean }) => (open ? React.createElement('alert-dialog', props, children) : null),
  AlertDialogContent: host('alert-content'),
  AlertDialogHeader: host('alert-header'),
  AlertDialogTitle: host('alert-title'),
  AlertDialogDescription: host('alert-description'),
  AlertDialogFooter: host('alert-footer'),
  AlertDialogCancel: ({ children, ...props }: HostProps) => React.createElement('alert-cancel', props, children),
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: HostProps) => {
    buttons.push(props);
    return React.createElement('button', props, children);
  },
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/kortix/avatar', () => ({ Avatar: none }));
// The action sheet: renders its content, `open()` is observable, `close()`
// ends the dismiss animation synchronously (fires onDismiss).
mock.module('@/components/kortix/sheet', () => {
  const { forwardRef, useImperativeHandle } = React;
  return {
    Sheet: forwardRef(function Sheet(props: HostProps & { onDismiss?: () => void }, ref) {
      useImperativeHandle(ref, () => ({
        open: () => sheetOpen.push(1),
        // The real sheet fires onDismiss after its close animation, not in
        // the caller's stack — a macrotask stands in for the animation.
        close: () => {
          const dismiss = props.onDismiss;
          if (dismiss) setTimeout(dismiss, 0);
        },
        present: none,
        dismiss: () => {
          const dismiss = props.onDismiss;
          if (dismiss) setTimeout(dismiss, 0);
        },
      }));
      return React.createElement('sheet', null, props.children);
    }),
  } as Record<string, unknown>;
});
mock.module('@/components/kortix/settings-list', () => ({
  SettingsGroup: host('settings-group'),
  SettingsRow: ({ label, onPress, ...props }: HostProps & { label?: string; onPress?: () => void }) => {
    rows.push({ label, onPress });
    return React.createElement('settings-row', { label, ...props });
  },
}));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({ success: (m: string) => toastSuccess.push(m) }) }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: none, warning: none, medium: none, success: none } }));
mock.module('@/lib/projects/hooks', () => ({ useArchiveProject: () => archive }));
mock.module('@/lib/logger', () => ({ log: { error: none, warn: none, info: none } }));
mock.module('@/lib/utils/theme', () => ({
  THEME: { light: {}, dark: {} },
  withAlpha: (c: string) => c,
  MOTION: { easing: { out: [0, 0, 1, 1] }, duration: { moderate: 200 } },
}));

let ProjectActions: typeof import('./ProjectActions').ProjectActions;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ProjectActions } = await import('./ProjectActions'));
});

const project = {
  project_id: 'p1',
  name: 'Apollo',
  effective_project_role: 'manager',
} as never;

let tree: ReactTestRenderer | undefined;
const renderIt = () =>
  act(() => {
    tree = create(<ProjectActions project={project} onOpenProject={none} onClose={none} />);
  });
const rerenderIt = () =>
  act(() => {
    // A fresh onClose identity forces a real re-render (equal props would bail out).
    tree!.update(<ProjectActions project={project} onOpenProject={none} onClose={() => {}} />);
  });

const row = (label: string) => rows.find((r) => r.label === label) as { label?: string; onPress?: () => void } | undefined;
// Visible strings: Text nodes plus the mocked alert-dialog title/description,
// which hold raw string children.
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
  buttons.length = 0;
  toastSuccess.length = 0;
  sheetOpen.length = 0;
  archive.isPending = false;
  archive.deferred = undefined;
  archive.calls = 0;
});

describe('the ProjectActions archive confirm dialog', () => {
  test('archive opens the dialog after the sheet closes, naming the project', async () => {
    renderIt();
    expect(sheetOpen).toHaveLength(1);
    act(() => row('Archive project')!.onPress!());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(texts()).toContain('Archive project');
    expect(texts()).toContain('Archive “Apollo”?');
    expect(buttonByLabel('Archive project'));
  });

  test('while the archive request runs both buttons disable, the label becomes "Archiving…", and the dialog refuses to close', async () => {
    renderIt();
    act(() => row('Archive project')!.onPress!());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(archive.calls).toBe(0);
    await act(async () => {
      buttonByLabel('Archive project').props.onPress!();
      await Promise.resolve();
    });
    expect(archive.calls).toBe(1);
    rerenderIt(); // the mock's isPending flip only shows on the next render
    expect(texts()).toContain('Archiving…');
    expect(buttonByLabel('Archiving…').props.disabled).toBe(true);
    // The Cancel button sits inside `AlertDialogCancel asChild`, which owns the disabled prop.
    expect(tree!.root.findByType('alert-cancel' as never).props.disabled).toBe(true);
    // Cancel while pending: the dialog's onOpenChange(false) is refused.
    act(() => tree!.root.findByType('alert-dialog' as never).props.onOpenChange!(false));
    expect(texts()).toContain('Archiving…');
    // The request settles: the dialog closes and the toast confirms.
    await act(async () => {
      archive.deferred!.resolve();
      await Promise.resolve();
    });
    expect(texts()).not.toContain('Archive project');
    expect(toastSuccess).toEqual(['Project archived']);
  });

  test('a failed archive keeps the dialog open with the failure text and a re-enabled confirm', async () => {
    renderIt();
    act(() => row('Archive project')!.onPress!());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      buttonByLabel('Archive project').props.onPress!();
      await Promise.resolve();
    });
    await act(async () => {
      archive.deferred!.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(texts()).toContain('Unable to archive. Check your connection and try again.');
    expect(buttonByLabel('Archive project').props.disabled).toBe(false);
    // Retrying runs the mutation again.
    act(() => buttonByLabel('Archive project').props.onPress!());
    expect(archive.calls).toBe(2);
  });
});
