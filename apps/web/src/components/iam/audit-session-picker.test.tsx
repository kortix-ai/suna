// KRTX-1727: the audit log's Session filter was a `<Select>` over the first
// page of a project's sessions, so a session past page one could not be
// picked, and an id copied from an event or a log could not be used at all.
// These tests drive the real picker (trigger, popover, cmdk input) in a
// happy-dom window: the search goes to the server, and a pasted session id is
// a filter of its own. Only `listProjectSessionsPage` is a fake.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import type { Container, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
// Radix Presence reads the popover's animation name.
globals.getComputedStyle = win.getComputedStyle.bind(win);
for (const key of Object.getOwnPropertyNames(win)) {
  // Event classes too: Radix dispatches a `CustomEvent` on a happy-dom node,
  // which accepts only happy-dom's own events, not Bun's.
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    globals[key] = Reflect.get(win, key);
  }
}

// After the window exists: react-dom decides at load whether the DOM fires
// `input` events, and without them a typed search never reaches React.
const { createRoot } = await import('react-dom/client');

type Row = { session_id: string; name: string | null };
const PROJECT = '00000000-0000-4000-8000-0000000000aa';
const OLD_SESSION = '11111111-1111-4111-8111-111111111111';
const DELETED_SESSION = '22222222-2222-4222-8222-222222222222';
const sessions: Row[] = [
  { session_id: '33333333-3333-4333-8333-333333333333', name: 'Deploy the docs' },
  { session_id: OLD_SESSION, name: 'Fix the login bug' },
];
const calls: Array<{ projectId: string; options: Record<string, unknown> }> = [];

const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...realSdk,
  // The server's `q`: a title or a session-id prefix.
  listProjectSessionsPage: async (projectId: string, options: Record<string, unknown>) => {
    calls.push({ projectId, options });
    const q = String(options.q ?? '').toLowerCase();
    const items = sessions.filter(
      (row) => !q || row.session_id.startsWith(q) || (row.name ?? '').toLowerCase().includes(q),
    );
    return { items, next_cursor: null };
  },
}));
const { AuditSessionPicker, AUDIT_SESSION_SEARCH_LIMIT } = await import('./audit-session-picker');

let root: Root | null = null;
let host: HTMLElement | null = null;
let chosen: string[] = [];

function Harness({ projectId }: { projectId: string }) {
  const [value, setValue] = useState('');
  return (
    <AuditSessionPicker
      projectId={projectId}
      value={value}
      onChange={(sessionId) => {
        chosen.push(sessionId);
        setValue(sessionId);
      }}
    />
  );
}

async function render(projectId: string) {
  host = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host as unknown as Container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <Harness projectId={projectId} />
      </QueryClientProvider>,
    );
  });
}

/** Past the 250 ms search debounce, and every query answer rendered. */
async function settle(ms = 300) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const body = () => win.document.body as unknown as HTMLElement;
const trigger = () => host!.querySelector('button') as HTMLButtonElement;
const input = () => body().querySelector('[data-slot="command-input"]') as HTMLInputElement | null;
const items = () => [...body().querySelectorAll('[data-slot="command-item"]')] as HTMLElement[];
const itemText = () => items().map((item) => item.textContent);
const empty = () => body().querySelector('[data-slot="command-empty"]')?.textContent ?? null;

async function open() {
  await act(async () => trigger().click());
  await settle();
}

async function type(text: string) {
  const field = input()!;
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field, text);
    field.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  });
  // The debounce, then the search's answer.
  await settle();
  await settle(50);
}

async function pick(index: number) {
  await act(async () => items()[index]!.click());
  await settle(20);
}

beforeEach(() => {
  calls.length = 0;
  chosen = [];
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  win.document.body.innerHTML = '';
});

describe('AuditSessionPicker (KRTX-1727)', () => {
  test('the trigger reads "All sessions" until a session is picked', async () => {
    await render(PROJECT);
    expect(trigger().textContent).toBe('All sessions');
  });

  test('opening reads one bounded page of the project, all scopes, no search yet', async () => {
    await render(PROJECT);
    await open();
    expect(input()?.getAttribute('placeholder')).toBe('Search or paste a session ID');
    expect(calls).toEqual([
      { projectId: PROJECT, options: { scope: 'project', q: undefined, limit: AUDIT_SESSION_SEARCH_LIMIT } },
    ]);
    expect(itemText()).toEqual([
      'All sessions',
      `Deploy the docs${sessions[0]!.session_id}`,
      `Fix the login bug${OLD_SESSION}`,
    ]);
  });

  test('typing searches on the server, and a picked row names the trigger', async () => {
    await render(PROJECT);
    await open();
    await type('login');
    expect(calls.at(-1)).toEqual({
      projectId: PROJECT,
      options: { scope: 'project', q: 'login', limit: AUDIT_SESSION_SEARCH_LIMIT },
    });
    expect(itemText()).toEqual([`Fix the login bug${OLD_SESSION}`]);
    await pick(0);
    expect(chosen).toEqual([OLD_SESSION]);
    expect(trigger().textContent).toBe('Fix the login bug');
  });

  test('a pasted id the search does not list is still a filter', async () => {
    await render(PROJECT);
    await open();
    await type(DELETED_SESSION);
    expect(itemText()).toEqual([`${DELETED_SESSION}Session ID`]);
    await pick(0);
    expect(chosen).toEqual([DELETED_SESSION]);
    expect(trigger().textContent).toBe(DELETED_SESSION);
  });

  test('a pasted id the search finds shows once, as its row', async () => {
    await render(PROJECT);
    await open();
    await type(OLD_SESSION);
    expect(itemText()).toEqual([`Fix the login bug${OLD_SESSION}`]);
  });

  test('no match: the empty line names the search', async () => {
    await render(PROJECT);
    await open();
    await type('nothing like this');
    expect(items()).toHaveLength(0);
    expect(empty()).toBe('No sessions matched "nothing like this"');
  });

  test('without a project: no request, and a pasted id still filters', async () => {
    await render('');
    await open();
    expect(calls).toEqual([]);
    await type('login');
    expect(empty()).toBe('Select project first');
    await type(DELETED_SESSION);
    expect(itemText()).toEqual([`${DELETED_SESSION}Session ID`]);
    await pick(0);
    expect(chosen).toEqual([DELETED_SESSION]);
    expect(calls).toEqual([]);
  });

  test('"All sessions" clears the filter', async () => {
    await render(PROJECT);
    await open();
    await pick(1);
    expect(trigger().textContent).toBe('Deploy the docs');
    await open();
    await pick(0);
    expect(chosen).toEqual([sessions[0]!.session_id, '']);
    expect(trigger().textContent).toBe('All sessions');
  });
});
