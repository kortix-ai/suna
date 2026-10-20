/**
 * Container-level characterization of the two "New template" entry points —
 * the header action and the empty-state action — and the one behavior that
 * separates them: after the template form closes from an edit, the container's
 * `editingTemplate` state still holds the edited template (closing does not
 * clear it). When that template then disappears (deleted), the empty-state
 * action must still open the form in CREATE mode.
 *
 * Before the fix the empty-state button called `setFormOpen(true)` without
 * resetting `editingTemplate`, so the form reopened in EDIT mode prefilled
 * with the deleted template — submitting PATCHed a dead `template_id`. The
 * header action never had the bug (it resets via `openNewForm`), and both
 * tests below pin both buttons so the two paths cannot drift apart again.
 *
 * `SandboxTab` owns hooks (React Query, capabilities, i18n) and the mounted
 * `SandboxTemplateForm`, so it cannot render under `renderToStaticMarkup`
 * like `SandboxTabView` in `sandbox-tab.test.tsx`. This file mounts it for
 * real under happy-dom (`navbar.test.tsx` pattern) with the query caches
 * pre-seeded — no network, no SDK mock — and swaps the dialog for a probe
 * component that exposes exactly the props the container passes it
 * (`open`, `template`): the form's create-vs-edit decision is
 * `isEdit = !!template`, so the `template` prop IS the mode.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { type Container, type Root, createRoot } from 'react-dom/client';

import { qk } from '@kortix/sdk/react';

import type { SandboxTemplate } from '@kortix/sdk';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);

/** Both capabilities the tab gates on, granted — the actions must render. */
mock.module('../../../internal/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: true }),
  useProjectCans: (projectId: string | undefined, actions: readonly string[]) =>
    Object.fromEntries(actions.map((action) => [action, { allowed: true }])),
  projectPermissionTarget: () => undefined,
  projectPermissionProbes: () => [],
}));

mock.module('../../../internal/lib/manifest-version', () => ({
  // The mock replaces the whole module, and the tab also statically imports
  // `manifestFilename` — a missing binding fails the module link, so mirror
  // the real pair (a v2 read renders the kortix.yaml label).
  manifestFilename: (version: number | null) =>
    (version ?? 1) >= 2 ? 'kortix.yaml' : 'kortix.toml',
  useProjectManifestVersion: () => ({ version: 2, isLoading: false }),
}));

/**
 * The dialog replaced by a probe: it renders the exact props the container
 * hands it, so the test can assert on the create/edit mode the container
 * selected. The close button drives `onOpenChange(false)` — the same call the
 * real dialog's overlay/escape/close make, and the call that leaves
 * `editingTemplate` behind.
 */
mock.module('./sandbox-template-form', () => ({
  SandboxTemplateForm: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    template?: SandboxTemplate | null;
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'template-form',
        'data-open': String(props.open),
        'data-mode': props.template ? 'edit' : 'create',
        'data-template-id': props.template?.template_id ?? '',
      },
      props.open
        ? React.createElement(
            'button',
            { type: 'button', onClick: () => props.onOpenChange(false) },
            'form-close',
          )
        : null,
    ),
}));

const { SandboxTab } = await import('./sandbox-tab');

const PROJECT = 'proj_empty_new';

const template = (overrides: Partial<SandboxTemplate> = {}): SandboxTemplate => ({
  template_id: 'tpl_1',
  slug: 'default',
  name: 'Default sandbox',
  is_default: false,
  source: 'toml',
  provider: 'daytona',
  has_dockerfile: false,
  has_image: true,
  image: 'kortixai/sandbox-base:2026.08',
  dockerfile_path: null,
  entrypoint: null,
  cpu: 2,
  memory_gb: 4,
  disk_gb: 20,
  snapshot_name: 'snap-1',
  content_hash: 'abc123',
  built_from_commit: null,
  daytona_state: 'active',
  provider_state: 'active',
  ready: true,
  ...overrides,
});

const snapshots = (templates: SandboxTemplate[]) => ({
  templates,
  templates_error: null,
  builds: [],
});

/** React Query v5 batches cache-observer notifies on a `setTimeout(0)` — a
 *  plain `await` inside `act` would leave the re-render outside act and un-
 *  flushed. One macrotask inside act covers it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Untyped DOM lookups get a named failure instead of a non-null assertion. */
const need = <T,>(value: T | null | undefined, what: string): T => {
  if (value == null) throw new Error(`${what} not found`);
  return value;
};

let root: Root | undefined;
let container: HTMLElement | undefined;
let qc: QueryClient | undefined;

/** Mounts `SandboxTab` with the snapshots cache pre-seeded (`templates`). The
 *  seeded data is fresh under the tab's `config` contract, so no query
 *  function ever runs and no network is touched. */
async function mountTab(templates: SandboxTemplate[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qk.project.snapshots(PROJECT), snapshots(templates));
  qc = client;

  // The happy-dom node crosses into react-dom and the lib.dom-typed helpers:
  // cast at the boundary like `audit-session-picker.test.tsx`.
  const el = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.appendChild(el as never);
  container = el;
  const mounted = createRoot(el as unknown as Container);
  root = mounted;
  await act(async () => {
    mounted.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(SandboxTab, { projectId: PROJECT }),
      ),
    );
  });
  return el;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container = undefined;
  qc = undefined;
});

const formState = (el: HTMLElement) => {
  const form = el.querySelector('[data-testid="template-form"]');
  if (!form) throw new Error('the template form probe did not render');
  return {
    open: form.getAttribute('data-open') ?? '',
    mode: form.getAttribute('data-mode') ?? '',
    templateId: form.getAttribute('data-template-id') ?? '',
  };
};

/** The two "New template" buttons in DOM order: [0] header action (inside
 *  `SettingsTabHeader`), [1] the empty-state action (inside `EmptyState`). */
const newButtons = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('button')).filter((b) => b.textContent?.trim() === 'New template');

describe('SandboxTab new-template entry points', () => {
  test('a clean empty state opens the form in create mode', async () => {
    const el = await mountTab([]);

    // Both actions render over an empty list: the header action and the
    // empty-state action (header first in DOM order, empty state last).
    expect(newButtons(el)).toHaveLength(2);
    await act(async () => {
      need(newButtons(el).at(-1), 'the empty-state New template button').click();
      await settle();
    });

    expect(formState(el)).toEqual({ open: 'true', mode: 'create', templateId: '' });
  });

  test('the header action opens the form in create mode after a stale edit', async () => {
    const el = await mountTab([template()]);

    // Edit the template, then close — the container keeps `editingTemplate`.
    await act(async () => {
      need(
        el.querySelector<HTMLButtonElement>('button[aria-label="Edit template"]'),
        'the Edit template button',
      ).click();
    });
    expect(formState(el)).toEqual({ open: 'true', mode: 'edit', templateId: 'tpl_1' });
    await act(async () => {
      need(
        el.querySelector<HTMLButtonElement>('[data-testid="template-form"] button'),
        'the form close button',
      ).click();
    });
    expect(formState(el).open).toBe('false');

    // The header action resets the stale template — pinned so the empty-state
    // fix cannot regress this path (they must stay identical).
    await act(async () => {
      need(newButtons(el)[0], 'the header New template button').click();
    });
    expect(formState(el)).toEqual({ open: 'true', mode: 'create', templateId: '' });
  });

  test('the empty-state action opens the form in create mode after the edited template is deleted', async () => {
    const el = await mountTab([template()]);

    // Edit the template, then close — the container keeps `editingTemplate`.
    await act(async () => {
      need(
        el.querySelector<HTMLButtonElement>('button[aria-label="Edit template"]'),
        'the Edit template button',
      ).click();
    });
    expect(formState(el)).toEqual({ open: 'true', mode: 'edit', templateId: 'tpl_1' });
    await act(async () => {
      need(
        el.querySelector<HTMLButtonElement>('[data-testid="template-form"] button'),
        'the form close button',
      ).click();
    });
    expect(formState(el).open).toBe('false');

    // The template goes away (deleted) and the empty state takes over.
    await act(async () => {
      need(qc, 'the query client').setQueryData(qk.project.snapshots(PROJECT), snapshots([]));
      await settle();
    });
    expect(el.textContent).toContain('No templates resolved yet.');
    expect(newButtons(el)).toHaveLength(2); // header + empty-state action

    // THE BUG: the empty-state New action must not reopen the form in edit
    // mode prefilled with the deleted template — its submit would PATCH a
    // dead `template_id`. Create mode is the only correct outcome here.
    await act(async () => {
      need(newButtons(el).at(-1), 'the empty-state New template button').click();
      await settle();
    });
    expect(formState(el)).toEqual({ open: 'true', mode: 'create', templateId: '' });
  });
});
