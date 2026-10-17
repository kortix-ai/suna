/**
 * The change request dialog (Files → Proposed changes, a session's change
 * request card, the command palette) offers each decision only to a viewer
 * whose leaves its route asserts (KRTX-1720, `changeRequestControlsFrom` in
 * `@kortix/sdk`, the mapping the Review Center reads):
 *
 * - Apply changes, and Fix with agent in its place: `POST …/merge`,
 *   project.write + project.gitops.merge.
 * - Dismiss and Reopen: `POST …/close` and `…/reopen`, project.write.
 *
 * The dialog made no probe at all. A built-in member saw Apply changes and
 * Dismiss, and the API answered each with 403.
 *
 * Runs the real dialog against `happy-dom`; the data hooks are stubs.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.localStorage = win.localStorage;
// The diff view registers a custom element on import.
globals.customElements = win.customElements;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
// Bun has its own event classes. The dialog's focus and dismiss layers create
// events by bare global name, and happy-dom dispatches only its own.
for (const key of [
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
]) {
  globals[key] = Reflect.get(win, key);
}

type Status = 'open' | 'closed';
let status: Status = 'open';
let conflicts: string[] = [];
let leaves: Record<string, { allowed: boolean }> = {};

const idleMutation = { mutate() {}, isPending: false, error: null, variables: undefined };
const changeRequests = await import('../hooks/use-change-requests');
mock.module('../hooks/use-change-requests', () => ({
  ...changeRequests,
  useChangeRequest: () => ({
    data: {
      change_request: {
        cr_id: 'cr-1',
        number: 7,
        title: 'Tidy the footer',
        description: '',
        status,
        base_ref: 'main',
        head_ref: 'session/footer',
        created_at: '2026-10-13T08:00:00.000Z',
        closed_at: status === 'closed' ? '2026-10-13T09:00:00.000Z' : null,
        merged_at: null,
      },
    },
  }),
  useChangeRequestDiff: () => ({ data: { files: [], patch: '' }, isLoading: false }),
  useChangeRequestMergePreview: () => ({
    data: { is_up_to_date: false, can_merge: conflicts.length === 0, conflicts },
  }),
  useMergeChangeRequest: () => idleMutation,
  useCloseChangeRequest: () => idleMutation,
  useReopenChangeRequest: () => idleMutation,
}));
mock.module('../hooks/use-change-request-recovery', () => ({
  useChangeRequestRecovery: () => ({ startRecovery() {}, startingCrId: null }),
}));
const manifestVersion =
  await import('@/features/workspace/customize/migrate-to-v2/manifest-version');
mock.module('@/features/workspace/customize/migrate-to-v2/manifest-version', () => ({
  ...manifestVersion,
  useProjectManifestVersion: () => ({ version: 2 }),
}));
const projectCan = await import('@/lib/use-project-can');
mock.module('@/lib/use-project-can', () => ({
  ...projectCan,
  useProjectCans: (_projectId: string, actions: readonly string[]) =>
    Object.fromEntries(actions.map((action) => [action, leaves[action] ?? { allowed: false }])),
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { NextIntlClientProvider } = await import('@/i18n/use-translations');
const { PROJECT_ACTIONS } = await import('@kortix/sdk');
const messages = (await import('../../../../translations/en.json')).default;
const { ProjectFilesProvider } = await import('../context');
const { ChangeRequestDetailDialog } = await import('./change-request-detail-dialog');

const { PROJECT_WRITE, PROJECT_GITOPS_PUSH, PROJECT_GITOPS_MERGE, PROJECT_REVIEW_ACT } =
  PROJECT_ACTIONS;
const grant = (...granted: string[]) =>
  Object.fromEntries(granted.map((leaf) => [leaf, { allowed: true }]));
/** A built-in member: review.read + review.submit, none of these leaves. */
const MEMBER = grant();
const MANAGER = grant(PROJECT_WRITE, PROJECT_GITOPS_PUSH, PROJECT_GITOPS_MERGE, PROJECT_REVIEW_ACT);
/** A custom role that reviews and does not merge. */
const REVIEWER = grant(PROJECT_WRITE, PROJECT_REVIEW_ACT);

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(next: Record<string, { allowed: boolean }>) {
  leaves = next;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
          <ProjectFilesProvider value={{ projectId: 'p1', ref: '', defaultBranch: 'main' }}>
            <ChangeRequestDetailDialog crId="cr-1" onClose={() => {}} />
          </ProjectFilesProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  status = 'open';
  conflicts = [];
  document.body.innerHTML = '';
});

/** The visible label of every button in the open dialog. */
const buttons = () =>
  [...document.querySelectorAll('[role="dialog"] button')].map(
    (button) => button.textContent?.trim() ?? '',
  );

describe('an open change request', () => {
  test('a built-in member gets no Apply changes and no Dismiss', () => {
    mount(MEMBER);
    expect(document.body.textContent).toContain('Tidy the footer');
    expect(buttons()).not.toContain('Apply changes');
    expect(buttons()).not.toContain('Dismiss');
  });

  test('a reviewer without the merge leaf dismisses and does not apply', () => {
    mount(REVIEWER);
    expect(buttons()).toContain('Dismiss');
    expect(buttons()).not.toContain('Apply changes');
  });

  test('a manager gets Dismiss and Apply changes', () => {
    mount(MANAGER);
    expect(buttons()).toContain('Dismiss');
    expect(buttons()).toContain('Apply changes');
  });

  test('a conflicted change offers Fix with agent, in place of the apply, only to a viewer who may merge', () => {
    conflicts = ['README.md'];
    mount(REVIEWER);
    expect(buttons()).not.toContain('Fix with agent');
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(MANAGER);
    expect(buttons()).toContain('Fix with agent');
  });
});

describe('a dismissed change request', () => {
  test('Reopen needs project.write', () => {
    status = 'closed';
    mount(MEMBER);
    expect(buttons()).not.toContain('Reopen');
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(grant(PROJECT_WRITE));
    expect(buttons()).toContain('Reopen');
  });
});
