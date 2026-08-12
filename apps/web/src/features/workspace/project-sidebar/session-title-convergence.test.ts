/**
 * The three surfaces that show a session name must converge on it together.
 *
 * `generateSessionTitleFromFirstPrompt` (apps/api) writes
 * `project_sessions.metadata.name` fire-and-forget, 3–15s after the first
 * prompt, and emits NOTHING — no SSE event, no invalidation, no notification
 * path of any kind. The browser's live event stream comes from opencode inside
 * the sandbox, not from the Kortix API, so the API cannot announce it there
 * without a transport it does not have.
 *
 * So every surface discovered the title by accident, whenever its own refetch
 * policy happened to fire, and the three policies differ:
 *
 *   - the session header's query: `refetchOnWindowFocus: false`, no interval —
 *     it NEVER refetches, and was only ever correct because it shares a cache
 *     entry with the sidebar;
 *   - the sidebar: 5s while provisioning, then 60s while a session is open,
 *     then nothing;
 *   - the sessions page: a DIFFERENT key ('project' scope), 5s while
 *     provisioning, then nothing until window focus.
 *
 * A new session lands its title inside the window where the first has gone
 * quiet and the third has stopped polling. All three legitimately disagree.
 *
 * The fix is a bounded fast poll keyed on the one thing that is observable
 * from the client: whether a session still has no title. That is what these
 * tests pin.
 */
import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';

import {
  UNTITLED_SESSION_LABEL,
  getSessionDisplayTitle,
  hasSessionAwaitingTitle,
  projectSessionsRefetchInterval,
  sessionTitleHasLanded,
} from './project-session-list-helpers';

/** Fixed clock, so the age bound below is asserted rather than raced. */
const NOW = Date.parse('2026-08-12T12:00:00.000Z');

function session(over: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 's1',
    status: 'running',
    // Young by default: the interesting case for most of this file is a
    // session whose title is still in flight.
    created_at: new Date(NOW - 2_000).toISOString(),
    custom_name: null,
    name: null,
    metadata: {},
    ...over,
  } as unknown as ProjectSession;
}

describe('sessionTitleHasLanded', () => {
  test('false while the server has written no name of any kind', () => {
    expect(sessionTitleHasLanded(session())).toBe(false);
  });

  test('true for each of the three name sources, in isolation', () => {
    // Each is independently sufficient. Asserted separately rather than as one
    // OR so a precedence change cannot silently drop a source.
    expect(sessionTitleHasLanded(session({ name: 'Fix The Proxy' }))).toBe(true);
    expect(sessionTitleHasLanded(session({ custom_name: 'My Rename' }))).toBe(true);
    expect(
      sessionTitleHasLanded(session({ metadata: { session_name: 'Legacy Name' } })),
    ).toBe(true);
  });

  test('whitespace is not a title — it is what an empty generation writes', () => {
    expect(sessionTitleHasLanded(session({ name: '   ' }))).toBe(false);
  });

  test('agrees with what the row actually renders, so the two cannot drift', () => {
    // The bug this guards: a predicate that says "titled" while the row still
    // shows the placeholder would stop the poll with the UI still wrong.
    const untitled = session();
    expect(sessionTitleHasLanded(untitled)).toBe(false);
    expect(getSessionDisplayTitle(untitled)).toBe(UNTITLED_SESSION_LABEL);

    const titled = session({ name: 'Fix The Proxy' });
    expect(sessionTitleHasLanded(titled)).toBe(true);
    expect(getSessionDisplayTitle(titled)).not.toBe(UNTITLED_SESSION_LABEL);
  });
});

describe('hasSessionAwaitingTitle', () => {
  test('true when any one session in the list is still waiting', () => {
    expect(hasSessionAwaitingTitle([session({ name: 'Titled' }), session()], NOW)).toBe(true);
  });

  test('false once every session has a name', () => {
    expect(
      hasSessionAwaitingTitle([session({ name: 'A' }), session({ custom_name: 'B' })], NOW),
    ).toBe(false);
  });

  test('false for empty and undefined — nothing to wait for', () => {
    expect(hasSessionAwaitingTitle([], NOW)).toBe(false);
    expect(hasSessionAwaitingTitle(undefined, NOW)).toBe(false);
  });
});

describe('projectSessionsRefetchInterval — converging on a pending title', () => {
  test('polls fast while a title is still pending, with no session open', () => {
    // The sessions PAGE case: no session is open, nothing is provisioning, and
    // before this fix the answer was `false` — so a title written seconds later
    // was never picked up until the window regained focus.
    const interval = projectSessionsRefetchInterval({
      sessions: [session()],
      hasOpenSession: false,
      now: NOW,
    });

    expect(interval).not.toBe(false);
    expect(interval as number).toBeLessThanOrEqual(5_000);
  });

  test('polls fast while a title is pending even though a session is open', () => {
    // The HEADER case. 60s was the open-session interval, which is far longer
    // than the 15s title-generation timeout — so the header showed
    // "New session" for most of a minute after the name already existed.
    const interval = projectSessionsRefetchInterval({
      sessions: [session()],
      hasOpenSession: true,
      now: NOW,
    });

    expect(interval as number).toBeLessThanOrEqual(5_000);
  });

  test('stops the fast poll as soon as every title has landed', () => {
    // Bounded, not a permanent 5s poll on every project page.
    expect(
      projectSessionsRefetchInterval({
        sessions: [session({ name: 'Titled' })],
        hasOpenSession: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  test('an open session still falls back to its slow activity poll once titled', () => {
    // The pre-existing reason this poll exists at all — last-activity moves a
    // row between the Today / Yesterday sections — must survive the change.
    expect(
      projectSessionsRefetchInterval({
        sessions: [session({ name: 'Titled' })],
        hasOpenSession: true,
        now: NOW,
      }),
    ).toBe(60_000);
  });

  test('provisioning still wins over everything', () => {
    expect(
      projectSessionsRefetchInterval({
        sessions: [session({ status: 'provisioning', name: 'Titled' })],
        hasOpenSession: false,
        now: NOW,
      }),
    ).toBe(5_000);
  });

  test('gives up on a title that is never coming, instead of polling forever', () => {
    // A session only gets a name off its FIRST PROMPT. Create one and never
    // prompt it and no name is ever written — so "untitled" alone is not a
    // reason to keep asking. Without this bound, one abandoned session would
    // put a project page into a permanent 3s poll.
    const abandoned = session({ created_at: new Date(NOW - 30 * 60_000).toISOString() });

    expect(
      projectSessionsRefetchInterval({
        sessions: [abandoned],
        hasOpenSession: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  test('still polls for a title that is genuinely in flight', () => {
    // The other side of the same bound: a session created seconds ago is
    // exactly the case this whole change exists for.
    const justCreated = session({ created_at: new Date(NOW - 4_000).toISOString() });

    expect(
      projectSessionsRefetchInterval({
        sessions: [justCreated],
        hasOpenSession: false,
        now: NOW,
      }),
    ).toBe(3_000);
  });

  test('a missing or unparseable created_at does not start an unbounded poll', () => {
    // Fail closed. An unknown age cannot be proven young, and the cost of
    // guessing wrong is the permanent poll this bound exists to prevent.
    for (const created of [null, undefined, 'not-a-date']) {
      expect(
        projectSessionsRefetchInterval({
          sessions: [session({ created_at: created as unknown as string })],
          hasOpenSession: false,
          now: NOW,
        }),
      ).toBe(false);
    }
  });
});
