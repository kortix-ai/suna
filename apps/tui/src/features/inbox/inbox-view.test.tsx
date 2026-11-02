import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import type { InboxRow } from './inbox-model.ts';
import { InboxView, type InboxViewProps, inboxRowText, rightText } from './inbox-view.tsx';
import { INBOX_KEYS } from './keys.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 3_600_000;
const SIZE = { width: 84, height: 24 };

function rows(): InboxRow[] {
  return [
    {
      id: 'n-1',
      title: 'Which bank should I use?',
      kind: 'Question',
      glyph: '?',
      tone: 'busy',
      projectName: 'Atlas',
      projectId: 'p-1',
      sessionId: 's-1',
      body: 'Two options: Mercury or Brex.',
      url: '/projects/p-1/sessions/s-1',
      read: false,
      needsYou: true,
      createdMs: NOW - 3 * MINUTE,
    },
    {
      id: 'n-2',
      title: 'Deal desk summary',
      kind: 'Turn finished',
      glyph: '✓',
      tone: 'ok',
      projectName: 'Atlas',
      projectId: 'p-1',
      sessionId: 's-2',
      body: '',
      url: '/projects/p-1/sessions/s-2',
      read: true,
      needsYou: false,
      createdMs: NOW - 2 * HOUR,
    },
    {
      id: 'n-3',
      title: 'Nightly digest',
      kind: 'Failure alert',
      glyph: '!',
      tone: 'bad',
      projectName: null,
      projectId: 'p-1',
      sessionId: null,
      body: 'Exit 1',
      url: '/projects/p-1/triggers',
      read: false,
      needsYou: true,
      createdMs: NOW - 26 * HOUR,
    },
  ];
}

function props(overrides: Partial<InboxViewProps> = {}): InboxViewProps {
  return {
    rows: rows(),
    unreadCount: 2,
    focused: true,
    width: 82,
    height: 20,
    now: NOW,
    loading: false,
    errorMessage: null,
    onOpen: () => {},
    onMarkRead: () => {},
    onMarkAllRead: () => {},
    onOpenWeb: () => {},
    onRefresh: () => {},
    onBack: () => {},
    ...overrides,
  };
}

async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

describe('row text', () => {
  test('an unread row leads with the dot, the kind glyph and the title', () => {
    const text = inboxRowText(rows()[0] as InboxRow, NOW, 82);
    expect(text.startsWith('● ? Which bank should I use?')).toBe(true);
    expect(text.trimEnd().endsWith('Question · Atlas · 3m')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
  });

  test('a read row has a blank first column', () => {
    expect(inboxRowText(rows()[1] as InboxRow, NOW, 82).startsWith('  ✓ Deal desk summary')).toBe(
      true,
    );
  });

  test('the right column skips a missing project', () => {
    expect(rightText(rows()[2] as InboxRow, NOW)).toBe('Failure alert · 1d');
  });
});

describe('<InboxView/>', () => {
  test('draws the header, the rows and the body of the selected row', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <InboxView {...props()} />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('All · 2 unread');
    expect(frame).toContain('Which bank should I use?');
    expect(frame).toContain('Turn finished · Atlas · 2h');
    expect(frame).toContain('Two options: Mercury or Brex.');
    renderer.destroy();
  });

  test('f cycles the filter and the list follows', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <InboxView {...props()} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('f'));
    await flush();
    let frame = captureCharFrame();
    expect(frame).toContain('Unread ·');
    expect(frame).not.toContain('Deal desk summary');

    await act(async () => mockInput.pressKey('f'));
    await flush();
    frame = captureCharFrame();
    expect(frame).toContain('Needs you ·');
    expect(frame).toContain('Nightly digest');
    expect(frame).not.toContain('Deal desk summary');
    renderer.destroy();
  });

  test('Enter opens the row under the cursor; m marks only an unread row', async () => {
    const opened: string[] = [];
    const read: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <InboxView
        {...props({ onOpen: (r) => opened.push(r.id), onMarkRead: (r) => read.push(r.id) })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await act(async () => mockInput.pressKey('m'));
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressKey('m')); // n-2 is already read
    await flush();
    expect(opened).toEqual(['n-1']);
    expect(read).toEqual(['n-1']);
    renderer.destroy();
  });

  test('a marks all read only when something is unread', async () => {
    let all = 0;
    const withUnread = await testRender(
      <InboxView {...props({ onMarkAllRead: () => all++ })} />,
      SIZE,
    );
    await withUnread.flush();
    await act(async () => withUnread.mockInput.pressKey('a'));
    expect(all).toBe(1);
    withUnread.renderer.destroy();

    const none = await testRender(
      <InboxView {...props({ unreadCount: 0, onMarkAllRead: () => all++ })} />,
      SIZE,
    );
    await none.flush();
    await act(async () => none.mockInput.pressKey('a'));
    expect(all).toBe(1);
    expect(none.captureCharFrame()).toContain('All · all read');
    none.renderer.destroy();
  });

  test('o hands the row to the browser opener; Esc goes back', async () => {
    const web: string[] = [];
    let backs = 0;
    const { flush, mockInput, renderer } = await testRender(
      <InboxView {...props({ onOpenWeb: (r) => web.push(r.id), onBack: () => backs++ })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('o'));
    await pressEscape(mockInput);
    expect(web).toEqual(['n-1']);
    expect(backs).toBe(1);
    renderer.destroy();
  });

  test('loading, error and empty states', async () => {
    const loading = await testRender(<InboxView {...props({ rows: [], loading: true })} />, SIZE);
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading inbox');
    loading.renderer.destroy();

    const failed = await testRender(
      <InboxView {...props({ rows: [], errorMessage: 'HTTP 503: unavailable' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 503: unavailable');
    failed.renderer.destroy();

    const empty = await testRender(<InboxView {...props({ rows: [], unreadCount: 0 })} />, SIZE);
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('Nothing here yet');
    empty.renderer.destroy();
  });

  test('an empty filter says so instead of "nothing here yet"', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <InboxView
        {...props({ rows: rows().filter((r) => r.read), initialFilter: 'unread', unreadCount: 0 })}
      />,
      SIZE,
    );
    await flush();
    expect(captureCharFrame()).toContain('Nothing in this filter');
    renderer.destroy();
  });

  test('an unfocused view ignores keys', async () => {
    const opened: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <InboxView {...props({ focused: false, onOpen: (r) => opened.push(r.id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    expect(opened).toEqual([]);
    renderer.destroy();
  });
});

describe('INBOX_KEYS', () => {
  test('ids are unique and scoped inbox', () => {
    const ids = INBOX_KEYS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(INBOX_KEYS.every((b) => b.scope === 'inbox')).toBe(true);
  });
});
