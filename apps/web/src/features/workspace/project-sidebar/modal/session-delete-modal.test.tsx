// KRTX-1734: a session delete is restorable for 30 days. The modal says so,
// and its success toast offers Undo, which restores the session through the
// SDK, refreshes the session lists and, for the session the page had open,
// goes back to it. These tests render the real modal and click the real Undo
// button the toast carries.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}

type ToastCall = {
  kind: 'success' | 'error';
  message: string;
  options?: { id?: string; duration?: number; button?: ReactElement };
};
const toasts: ToastCall[] = [];
const dismissed: unknown[] = [];
mock.module('@/components/ui/toast', () => ({
  successToast: (message: string, options?: ToastCall['options']) => toasts.push({ kind: 'success', message, options }),
  errorToast: (message: string, options?: ToastCall['options']) => toasts.push({ kind: 'error', message, options }),
  dismissToast: (id: unknown) => dismissed.push(id),
}));

const sdkCalls: string[] = [];
let restoreAnswer: () => Promise<unknown> = async () => ({ ok: true });
mock.module('@kortix/sdk', () => ({
  deleteProjectSession: async (projectId: string, sessionId: string) => {
    sdkCalls.push(`delete ${projectId}/${sessionId}`);
    return { ok: true, restore_until: '2026-11-12T10:00:00.000Z' };
  },
  restoreProjectSession: async (projectId: string, sessionId: string) => {
    sdkCalls.push(`restore ${projectId}/${sessionId}`);
    return restoreAnswer();
  },
}));
mock.module('@kortix/sdk/react', () => ({
  qk: { project: { sessionsScope: (projectId: string) => ['project', projectId, 'sessions'] } },
  removeCachedProjectSession: () => () => undefined,
}));
let routeParams: { sessionId?: string } = {};
const pushes: string[] = [];
mock.module('next/navigation', () => ({
  useParams: () => routeParams,
  useRouter: () => ({ push: (href: string) => pushes.push(href) }),
}));
// The real dialog is a Radix portal; the subject here is what the modal hands it.
mock.module('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: { open: boolean; description: ReactNode; confirmLabel: string; onConfirm: () => void }) =>
    props.open ? (
      <div>
        <p data-description>{props.description}</p>
        <button type="button" data-confirm onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));

const { SessionDeleteModal } = await import('./session-delete-modal');

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

let roots: Root[] = [];
let invalidated: unknown[] = [];
const events: string[] = [];

function mount(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

async function deleteThroughModal(): Promise<HTMLElement> {
  const client = new QueryClient();
  client.invalidateQueries = (async (filters: { queryKey: unknown }) => {
    invalidated.push(filters.queryKey);
  }) as QueryClient['invalidateQueries'];
  const dialog = mount(
    <QueryClientProvider client={client}>
      <SessionDeleteModal
        projectId="P1"
        sessionId="S1"
        sessionLabel="Fix the login bug"
        open
        onOpenChange={(open) => events.push(`open:${open}`)}
        onDeleted={() => events.push('deleted')}
      />
    </QueryClientProvider>,
  );
  await act(async () => (dialog.querySelector('[data-confirm]') as HTMLButtonElement).click());
  await flush();
  return dialog;
}

async function clickUndo(): Promise<void> {
  const undo = toasts[0]?.options?.button;
  if (!undo) throw new Error('the delete toast carries no Undo button');
  const toast = mount(undo);
  await act(async () => (toast.querySelector('button') as HTMLButtonElement).click());
  await flush();
}

beforeEach(() => {
  toasts.length = 0;
  dismissed.length = 0;
  sdkCalls.length = 0;
  events.length = 0;
  pushes.length = 0;
  routeParams = {};
  invalidated = [];
  restoreAnswer = async () => ({ ok: true });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('SessionDeleteModal', () => {
  test('says the session can be restored for 30 days and that its branch is kept', async () => {
    const client = new QueryClient();
    const dialog = mount(
      <QueryClientProvider client={client}>
        <SessionDeleteModal projectId="P1" sessionId="S1" sessionLabel="Fix the login bug" open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    const description = dialog.querySelector('[data-description]')?.textContent ?? '';
    expect(description).toBe(
      'Deletes Fix the login bug and removes its sandbox. You can restore the session for 30 days. After that, its messages and files are deleted. Its branch is kept.',
    );
    expect(description).not.toContain('cannot be undone');
  });

  test('a confirmed delete toasts the result with an Undo button for 8 seconds', async () => {
    await deleteThroughModal();
    expect(sdkCalls).toEqual(['delete P1/S1']);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: 'success',
      message: '"Fix the login bug" deleted',
      options: { id: 'session-delete-undo-S1', duration: 8000 },
    });
    expect(events).toEqual(['deleted', 'open:false']);
  });

  test('Undo restores the session and refreshes the lists, and stays on the page', async () => {
    await deleteThroughModal();
    await clickUndo();
    expect(dismissed).toEqual(['session-delete-undo-S1']);
    expect(sdkCalls).toEqual(['delete P1/S1', 'restore P1/S1']);
    expect(toasts[1]).toEqual({ kind: 'success', message: 'Session restored', options: undefined });
    // Once for the delete, once for the restore.
    expect(invalidated).toEqual([
      ['project', 'P1', 'sessions'],
      ['project', 'P1', 'sessions'],
    ]);
    expect(events).toEqual(['deleted', 'open:false']);
    expect(pushes).toEqual([]);
  });

  test('Undo of the session the page had open goes back to it', async () => {
    routeParams = { sessionId: 'S1' };
    await deleteThroughModal();
    await clickUndo();
    expect(sdkCalls).toEqual(['delete P1/S1', 'restore P1/S1']);
    expect(pushes).toEqual(['/projects/P1/sessions/S1']);
  });

  test('a refused Undo shows the server reason and leaves the session deleted', async () => {
    restoreAnswer = async () => {
      throw new Error("The deleted session's sandbox is still being removed. Try again in a minute.");
    };
    await deleteThroughModal();
    await clickUndo();
    expect(toasts[1]).toEqual({
      kind: 'error',
      message: "The deleted session's sandbox is still being removed. Try again in a minute.",
      options: undefined,
    });
    expect(invalidated).toEqual([['project', 'P1', 'sessions']]);
    expect(events).toEqual(['deleted', 'open:false']);
    expect(pushes).toEqual([]);
  });

  test('a refusal with no message falls back to the catalog copy', async () => {
    restoreAnswer = async () => {
      throw new Error('');
    };
    await deleteThroughModal();
    await clickUndo();
    expect(toasts[1]).toMatchObject({ kind: 'error', message: 'Could not restore the session' });
  });
});
