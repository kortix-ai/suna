// KRTX-4038: pins who the rooms surfaces offer and how each row reads — the
// composer's `@` menu, the "Add people and agents" picker and the mention
// chips — so the three row builders can become one directory. These tests drive
// the real components in a happy-dom window. Only `fetch` is a fake: it
// answers the picker's people and sessions reads as the server does.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ProjectSession, RoomMember, RoomMessage, RoomPerson } from '@kortix/sdk';
import { configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';

const win = new Window({ width: 1440, height: 900 });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: win,
  document: win.document,
  navigator: win.navigator,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && (!(key in globalThis) || key.endsWith('Event'))) {
    Object.assign(globalThis, { [key]: Reflect.get(win, key) });
  }
}
// happy-dom has no layout: the picker scrolls its highlighted row into view.
Object.assign(win.HTMLElement.prototype, { scrollIntoView() {} });

// After the window exists: react-dom decides at load whether the DOM fires `input` events.
const { createRoot } = await import('react-dom/client');

const PROJECT = '00000000-0000-4000-8000-0000000000aa';
const VIEWER = 'aaaa0000-0000-4000-8000-000000000001';
const ADA = 'bbbb0000-0000-4000-8000-000000000002';
const GRACE = 'cccc0000-0000-4000-8000-000000000003';
const LINUS = 'dddd0000-0000-4000-8000-000000000004';
const SESSION_IN_ROOM = 'eeee0000-0000-4000-8000-000000000005';
const SESSION_TITLED = 'ffff0000-0000-4000-8000-000000000006';
const SESSION_UNTITLED = '99990000-0000-4000-8000-000000000007';

function member(kind: RoomMember['kind'], id: string, label: string): RoomMember {
  return {
    member_id: `m-${id}`,
    kind,
    session_id: kind === 'session' ? id : null,
    user_id: kind === 'person' ? id : null,
    project_id: PROJECT,
    label,
    notify: 'all',
    agent_name: null,
    status: null,
    added_by_user_id: VIEWER,
    joined_at: '2026-11-01T00:00:00.000Z',
  };
}

function session(id: string, name: string | null, agent: string | null, status: ProjectSession['status'] = 'stopped'): ProjectSession {
  return {
    session_id: id,
    account_id: 'account',
    project_id: PROJECT,
    branch_name: 'main',
    base_ref: 'main',
    sandbox_provider: null,
    sandbox_id: null,
    sandbox_url: null,
    opencode_session_id: null,
    name,
    custom_name: null,
    agent_name: agent,
    status,
    error: null,
    metadata: {},
    opencode_sessions: [],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };
}

const MEMBERS: RoomMember[] = [
  member('person', VIEWER, 'Viewer Person'),
  member('session', SESSION_IN_ROOM, 'eeee0000 (builder) "Fix CI"'),
  member('person', ADA, 'Ada Lovelace'),
];
const SESSIONS: ProjectSession[] = [
  session(SESSION_IN_ROOM, 'Fix CI', 'builder', 'running'),
  session(SESSION_TITLED, 'Deploy the docs', 'writer', 'running'),
];
const PEOPLE: RoomPerson[] = [
  { user_id: VIEWER, name: 'Viewer Person', email: 'viewer@example.test' },
  { user_id: ADA, name: 'Ada Lovelace', email: 'ada@example.test' },
  { user_id: GRACE, name: 'Grace Hopper', email: 'grace@example.test' },
];

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
let pickerPeople: RoomPerson[] = PEOPLE;
let pickerSessions: ProjectSession[] = SESSIONS;
const fakeFetch = async (input: URL | RequestInfo) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.endsWith('/rooms/people')) return Response.json({ people: pickerPeople });
  if (url.pathname.endsWith('/sessions')) return Response.json(pickerSessions);
  return Response.json({ error: 'not faked' }, { status: 404 });
};
spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fakeFetch, { preconnect: fetch.preconnect }));

const { RoomComposer } = await import('./room-composer');
const { PrincipalPicker } = await import('./principal-picker');
const { splitMessageText } = await import('./room-text');
const { repliersOf } = await import('./room-messages');
const { mentionTargets, principalRows } = await import('./use-room-directory');

let root: Root | null = null;

async function render(node: ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  pickerPeople = PEOPLE;
  pickerSessions = SESSIONS;
});

/** The adapter from the room's reads to the directory: the one place an API change edits. */
function directoryOf(members: RoomMember[], sessions: ProjectSession[], people: RoomPerson[]) {
  const rows = principalRows(members, sessions, people, VIEWER);
  return { rows, targets: mentionTargets(rows) };
}


function Composer({ members, sessions, people }: { members: RoomMember[]; sessions: ProjectSession[]; people: RoomPerson[] }) {
  return (
    <RoomComposer
      placeholder="Message #general"
      roomName="general"
      directory={directoryOf(members, sessions, people)}
      onSend={async () => {}}
    />
  );
}

const textarea = () => document.querySelector('textarea')!;

async function type(text: string) {
  const field = textarea();
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field, text);
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** What a row reads: its title, then ` — ` and its muted detail when it has one. */
function rowText(row: Element): string {
  const [title, detail] = [...row.querySelectorAll('span.truncate')].map((span) => span.textContent ?? '');
  return detail ? `${title} — ${detail}` : (title ?? '');
}

/** The menu as its sections: the heading, then each row's text. */
function menu(): string[][] {
  const list = document.querySelector('[role="listbox"]');
  if (!list) return [];
  return [...list.children].map((section) => [
    section.firstElementChild!.textContent ?? '',
    ...[...section.querySelectorAll('[role="option"]')].map(rowText),
  ]);
}

const selected = () => {
  const row = document.querySelector('[role="option"][aria-selected="true"]');
  return row ? rowText(row) : null;
};

describe('RoomComposer @ menu', () => {
  test('offers the room, then agents, then people, each once, and never the viewer', async () => {
    await render(<Composer members={MEMBERS} sessions={SESSIONS} people={PEOPLE} />);
    await type('@');
    expect(menu()).toEqual([
      ['In this room', 'Fix CI — builder', 'Ada Lovelace', '@here — Everyone in #general'],
      ['Agents', 'Deploy the docs — writer'],
      ['People', 'Grace Hopper — grace@example.test'],
    ]);
  });

  test('the query filters every section by name, agent or email', async () => {
    await render(<Composer members={MEMBERS} sessions={SESSIONS} people={PEOPLE} />);
    await type('Hi @grace');
    expect(menu()).toEqual([['People', 'Grace Hopper — grace@example.test']]);
    await type('Hi @writer');
    expect(menu()).toEqual([['Agents', 'Deploy the docs — writer']]);
    await type('Hi @zzz');
    expect(menu()).toEqual([]);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No matches');
  });

  test('each section shows at most six rows', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      user_id: `1234567${i}-0000-4000-8000-000000000000`,
      name: `Person ${i}`,
      email: `person${i}@example.test`,
    }));
    await render(<Composer members={[]} sessions={[]} people={many} />);
    await type('@person');
    expect(menu()[0]!.length).toBe(1 + 6);
  });

  test('a session inserts @ and 8 id characters, a person their email, @here itself', async () => {
    await render(<Composer members={MEMBERS} sessions={SESSIONS} people={PEOPLE} />);
    await type('Hi @fix');
    await press(textarea(), 'Enter');
    expect(textarea().value).toBe('Hi @eeee0000 ');
    await type('Hi @ada');
    await press(textarea(), 'Enter');
    expect(textarea().value).toBe('Hi @ada@example.test ');
    await type('Hi @her');
    await press(textarea(), 'Tab');
    expect(textarea().value).toBe('Hi @here ');
  });

  test('arrows move the highlight and wrap, and a new query starts again at the first row', async () => {
    await render(<Composer members={MEMBERS} sessions={SESSIONS} people={PEOPLE} />);
    await type('@');
    expect(selected()).toBe('Fix CI — builder');
    await press(textarea(), 'ArrowDown');
    expect(selected()).toBe('Ada Lovelace');
    await press(textarea(), 'ArrowUp');
    await press(textarea(), 'ArrowUp');
    expect(selected()).toBe('Grace Hopper — grace@example.test');
    await type('@d');
    expect(selected()).toBe('Ada Lovelace');
  });

  test('Escape closes the menu until the next @', async () => {
    await render(<Composer members={MEMBERS} sessions={SESSIONS} people={PEOPLE} />);
    await type('@');
    await press(textarea(), 'Escape');
    expect(menu()).toEqual([]);
    await type('@ @');
    expect(menu().length).toBe(3);
  });
});

describe('PrincipalPicker', () => {
  const picks: string[] = [];
  const picker = (exclude: Set<string>, pendingId: string | null = null) => (
    <PrincipalPicker
      projectId={PROJECT}
      viewerId={VIEWER}
      exclude={exclude}
      pendingId={pendingId}
      onPick={(pick) => picks.push(`${pick.kind}:${pick.id}:${pick.title}`)}
    />
  );
  const groups = () =>
    [...document.querySelectorAll('#room-principal-list section')].map((section) => [
      section.querySelector('label')?.textContent ?? '',
      ...[...section.querySelectorAll('[role="option"]')].map(rowText),
    ]);

  test('lists people, then agents, without the viewer and the current members', async () => {
    pickerSessions = [...SESSIONS, session(SESSION_UNTITLED, null, null)];
    await render(picker(new Set([ADA, SESSION_IN_ROOM])));
    expect(groups()).toEqual([
      ['People', 'Grace Hopper — grace@example.test'],
      ['Agents', 'Deploy the docs — writer · Running', '99990000 — Stopped'],
    ]);
  });

  test('arrows wrap and Enter picks the highlighted row with its label, unless a pick is pending', async () => {
    picks.length = 0;
    await render(picker(new Set([ADA, SESSION_IN_ROOM])));
    const input = document.querySelector('input')!;
    await press(input, 'ArrowUp');
    await press(input, 'Enter');
    expect(picks).toEqual([`session:${SESSION_TITLED}:Deploy the docs`]);
    await press(input, 'ArrowDown');
    await press(input, 'Enter');
    expect(picks.at(-1)).toBe(`person:${GRACE}:Grace Hopper`);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}>{picker(new Set(), GRACE)}</QueryClientProvider>));
    await press(document.querySelector('input')!, 'Enter');
    expect(picks.length).toBe(2);
  });
});

describe('mention chips', () => {
  test('a chip names a member, a project session and a person, and marks the viewer', async () => {
    let chips: string[] = [];
    function Probe() {
      const { targets } = directoryOf(MEMBERS, SESSIONS, PEOPLE);
      chips = splitMessageText('@eeee0000 @ffff0000 @grace@example.test @viewer@example.test @ada', targets).flatMap(
        (part) => (part.kind === 'mention' ? [`${part.label}${part.self ? ' (you)' : ''}`] : []),
      );
      return null;
    }
    await render(<Probe />);
    expect(chips).toEqual(['@Fix CI', '@Deploy the docs', '@Grace Hopper', '@Viewer Person (you)']);
  });
});

// The one change the refactor makes on purpose (KRTX-4038): a person reads the
// same in the menu, the picker and a chip — `personName` of the profile name.
// Outside the room's own members, their email, when that is not already their
// title, is the row's detail.
describe('one naming rule for a person', () => {
  const nameless: RoomPerson = { user_id: LINUS, name: null, email: 'linus@example.test' };

  test('the @ menu names a member with no profile name like their chip', async () => {
    let chip = '';
    function Probe() {
      const { targets } = directoryOf([member('person', LINUS, 'linus@example.test')], [], [nameless]);
      chip = splitMessageText('@linus@example.test', targets).flatMap((part) => (part.kind === 'mention' ? [part.label] : []))[0] ?? '';
      return null;
    }
    await render(
      <>
        <Probe />
        <Composer members={[member('person', LINUS, 'linus@example.test')]} sessions={[]} people={[nameless]} />
      </>,
    );
    await type('@linus');
    expect(chip).toBe('@linus');
    expect(menu()).toEqual([['In this room', 'linus']]);
  });

  test('the picker names a person with no profile name the same way', async () => {
    pickerPeople = [nameless];
    pickerSessions = [];
    await render(
      <PrincipalPicker projectId={PROJECT} viewerId={VIEWER} pendingId={null} onPick={() => {}} />,
    );
    expect([...document.querySelectorAll('#room-principal-list [role="option"]')].map(rowText)).toEqual(['linus — linus@example.test']);
  });
});

describe('thread repliers', () => {
  const reply = (seq: number, kind: RoomMessage['sender_kind'], id: string | null, label: string): RoomMessage => ({
    message_id: `m${seq}`,
    room_id: 'r',
    seq,
    sender_kind: kind,
    sender_user_id: kind === 'member' ? id : null,
    sender_session_id: kind === 'session' ? id : null,
    sender_label: label,
    text: 'x',
    reply_to_seq: 1,
    reply_count: 0,
    last_reply_at: null,
    created_at: '2026-11-01T00:00:00.000Z',
  });

  test('a sender is who the grouping rule says it is: one session twice is one replier, a person and a session never merge', () => {
    const repliers = repliersOf([
      reply(2, 'session', SESSION_TITLED, 'ffff0000 "Deploy the docs"'),
      reply(3, 'session', SESSION_TITLED, 'ffff0000 "Deploy the docs"'),
      reply(4, 'member', null, 'builder'),
      reply(5, 'session', null, 'builder'),
    ]);
    expect(repliers.map((r) => `${r.kind}:${r.label}`)).toEqual(['session:ffff0000 "Deploy the docs"', 'person:builder', 'session:builder']);
  });
});
