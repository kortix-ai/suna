// KRTX-1950: the first signed-in click on "Add to a project" once replaced
// the whole item page with the root error boundary — a commit-time
// DOMException (`insertBefore`/`removeChild` NotFoundError, the external DOM
// mutation class in `lib/browser-noise/rules/react.ts`) racing the dialog's
// first mount escalated past the marketplace page to `app/[locale]/error.tsx`.
// The guard scopes the blast radius to the dialog and rides out the race with
// one remount, so these tests run the real `ClientErrorBoundary` + guard
// wiring against a stand-in dialog that throws the canonical DOMException on
// its first open-mounts.
import { describe, expect, test } from 'bun:test';
import React, { act, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = (win as Record<string, unknown>)[key];
}

import { ClientErrorBoundary } from '@/components/common/error-boundary';
import { DialogCrashRecovery, useDialogCrashGuard } from './add-to-project-dialog-guard';

/** The exact V8 wording of the class the dogfood run hit (react.ts noise rules). */
function domMutationException(): Error {
  return new DOMException(
    "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    'NotFoundError',
  );
}

/** How many open-mounts happened, across every remount of the test dialog. */
let openMounts = 0;

/**
 * Stand-in for `AddToProjectModal`: an open dialog whose first `crashOpens`
 * mounts throw the DOM-mutation DOMException from a layout effect — a
 * commit-phase throw, the phase the production crash failed in.
 */
function CrashyDialogMount({ open, crashOpens }: { open: boolean; crashOpens: number }) {
  useLayoutEffect(() => {
    if (!open) return;
    openMounts += 1;
    if (openMounts <= crashOpens) throw domMutationException();
  }, [open, crashOpens]);
  return open ? <div data-dialog="open">dialog-content</div> : null;
}

/**
 * Stands in for `app/[locale]/error.tsx`: the boundary that owned the crash
 * before the guard, whose fallback replaces the whole page.
 */
class TopBoundary extends React.Component<{ children: React.ReactNode }, { failed: string | null }> {
  state: { failed: string | null } = { failed: null };

  static getDerivedStateFromError(error: unknown) {
    return { failed: String((error as Error)?.message ?? error) };
  }

  componentDidCatch() {}

  render() {
    if (this.state.failed) {
      return <div data-top="replaced">PAGE-REPLACED {this.state.failed}</div>;
    }
    return this.props.children;
  }
}

interface HarnessApi {
  changeOpen?: (open: boolean) => void;
}

/**
 * The production wiring: the guard hook feeds a keyed `ClientErrorBoundary`
 * whose fallback is the crash-recovery component, exactly like `ItemActions`.
 * Opens and closes go through the guard's `handleOpenChange`, the same path
 * the modal's own `onOpenChange` takes in the app.
 */
function GuardedHarness({ crashOpens, api }: { crashOpens: number; api: HarnessApi }) {
  const [open, setOpen] = useState(true);
  const guard = useDialogCrashGuard({ onOpenChange: setOpen });

  useEffect(() => {
    api.changeOpen = guard.handleOpenChange;
  }, [api, guard.handleOpenChange]);

  return (
    <div>
      <div data-page="item">item-page</div>
      <ClientErrorBoundary
        key={guard.mount}
        fallback={({ error }) => (
          <DialogCrashRecovery
            error={error}
            retried={guard.retried}
            onRetry={guard.onRetry}
            onGiveUp={guard.onGiveUp}
          />
        )}
      >
        <CrashyDialogMount open={open} crashOpens={crashOpens} />
      </ClientErrorBoundary>
    </div>
  );
}

/** The pre-guard wiring: the dialog directly under the root boundary. */
function UncontainedHarness({ crashOpens }: { crashOpens: number }) {
  const [open] = useState(true);
  return <CrashyDialogMount open={open} crashOpens={crashOpens} />;
}

async function renderHost(node: React.ReactNode): Promise<{ host: HTMLElement; root: Root }> {
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  return { host, root: root! };
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('Add-to-project dialog mount crash (KRTX-1950)', () => {
  test('without the guard a first-mount crash reaches the root boundary and replaces the page', async () => {
    openMounts = 0;
    const { host, root } = await renderHost(
      <TopBoundary>
        <UncontainedHarness crashOpens={1} />
      </TopBoundary>,
    );

    const html = host.innerHTML;
    expect(html).toContain('PAGE-REPLACED');
    expect(html).toContain('not a child of this node');
    expect(html).not.toContain('dialog-content');

    await act(async () => root.unmount());
  });

  test('the guard rides out the race: the dialog opens on the remount and the page stays', async () => {
    openMounts = 0;
    const { host, root } = await renderHost(
      <TopBoundary>
        <GuardedHarness crashOpens={1} api={{}} />
      </TopBoundary>,
    );
    await settle();

    const html = host.innerHTML;
    expect(html).toContain('item-page');
    expect(html).toContain('dialog-content');
    expect(html).not.toContain('PAGE-REPLACED');

    await act(async () => root.unmount());
  });

  test('a dialog that crashes on every mount gives up: closed, page intact, and the next open is bounded again', async () => {
    openMounts = 0;
    const api: HarnessApi = {};
    const { host, root } = await renderHost(
      <TopBoundary>
        <GuardedHarness crashOpens={999} api={api} />
      </TopBoundary>,
    );
    await settle();

    let html = host.innerHTML;
    expect(html).toContain('item-page');
    expect(html).not.toContain('dialog-content');
    expect(html).not.toContain('PAGE-REPLACED');
    // Give-up stopped after the retry: exactly two crashed mounts, no loop.
    expect(openMounts).toBe(2);

    // The user can try again: the next open is a fresh cycle, bounded the same way.
    await act(async () => api.changeOpen!(true));
    await settle();
    html = host.innerHTML;
    expect(html).toContain('item-page');
    expect(html).not.toContain('dialog-content');
    expect(html).not.toContain('PAGE-REPLACED');
    expect(openMounts).toBe(4);

    await act(async () => root.unmount());
  });

  test('the retry budget is per open: a recovered dialog reopens cleanly after a close', async () => {
    openMounts = 0;
    const api: HarnessApi = {};
    const { host, root } = await renderHost(
      <TopBoundary>
        <GuardedHarness crashOpens={1} api={api} />
      </TopBoundary>,
    );
    await settle();
    expect(host.innerHTML).toContain('dialog-content');

    // Close and reopen — the second open is a fresh cycle with a fresh budget.
    await act(async () => api.changeOpen!(false));
    await settle();
    expect(host.innerHTML).not.toContain('dialog-content');

    await act(async () => api.changeOpen!(true));
    await settle();
    expect(host.innerHTML).toContain('dialog-content');
    expect(host.innerHTML).not.toContain('PAGE-REPLACED');

    await act(async () => root.unmount());
  });
});
