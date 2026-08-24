import { describe, expect, test } from 'bun:test';
import { chatPlanAnchorId, planAnchorMessageId, planBelongsToChat } from './plan-anchor';
import type { PlanSurfaceState } from './plan-anchor';

type Msg = Parameters<typeof planAnchorMessageId>[0][number];

function user(id: string): Msg {
  return { info: { id, role: 'user' }, parts: [] } as unknown as Msg;
}

function assistant(id: string, tools: string[] = []): Msg {
  return {
    info: { id, role: 'assistant' },
    parts: tools.map((tool, i) => ({
      id: `${id}_p${i}`,
      type: 'tool',
      tool,
      callID: `call_${id}_${i}`,
      state: { status: 'completed' },
    })),
  } as unknown as Msg;
}

describe('planAnchorMessageId', () => {
  test('anchors the plan to the user message whose turn wrote the todos', () => {
    const messages = [
      user('u1'),
      assistant('a1', ['todowrite', 'bash']),
      user('u2'),
      assistant('a2', ['read']),
    ];

    // The reported bug: this returned 'u2' (the newest turn), so the plan card
    // migrated onto a message that never touched the plan.
    expect(planAnchorMessageId(messages)).toBe('u1');
  });

  test('a later turn that never writes todos does not steal the plan', () => {
    const messages = [
      user('u1'),
      assistant('a1', ['todowrite']),
      user('u2'),
      assistant('a2', ['bash']),
      user('u3'),
      assistant('a3', ['read', 'grep']),
    ];

    expect(planAnchorMessageId(messages)).toBe('u1');
  });

  test('a re-plan moves the anchor to the turn that re-planned', () => {
    const messages = [
      user('u1'),
      assistant('a1', ['todowrite']),
      user('u2'),
      assistant('a2', ['bash']),
      user('u3'),
      assistant('a3', ['todowrite']),
    ];

    expect(planAnchorMessageId(messages)).toBe('u3');
  });

  test('accepts both tool spellings', () => {
    expect(planAnchorMessageId([user('u1'), assistant('a1', ['todo_write'])])).toBe('u1');
    expect(planAnchorMessageId([user('u1'), assistant('a1', ['todowrite'])])).toBe('u1');
  });

  test('todos written while the turn is still streaming anchor to that turn', () => {
    const messages = [user('u1'), assistant('a1', ['bash']), user('u2'), assistant('a2', ['todowrite'])];

    expect(planAnchorMessageId(messages)).toBe('u2');
  });

  test('falls back to the last user message when no turn wrote todos', () => {
    // The session can hold todos with no `todowrite` part in the loaded
    // history — compaction drops old parts, and the todo list comes from the
    // runtime, not from the transcript. Keep the card reachable rather than
    // dropping it entirely.
    const messages = [user('u1'), assistant('a1', ['bash']), user('u2'), assistant('a2', ['read'])];

    expect(planAnchorMessageId(messages)).toBe('u2');
  });

  test('returns null when there is no user message at all', () => {
    expect(planAnchorMessageId([])).toBeNull();
    expect(planAnchorMessageId([assistant('a1', ['todowrite'])])).toBeNull();
  });

  test('ignores todo parts that precede any user message', () => {
    const messages = [assistant('a0', ['todowrite']), user('u1'), assistant('a1', ['bash'])];

    // No user message owned that write, so the fallback (last user) applies.
    expect(planAnchorMessageId(messages)).toBe('u1');
  });
});

/**
 * "Exactly one plan surface" — the rule `PlanPanelCard` and the transcript
 * card both obey, through `usePlanInChat`.
 *
 * The desktop cases below pin a PRODUCT decision, not a bug fix. An earlier
 * version handed the plan back to the transcript whenever the panel column was
 * off screen (collapsed, covered by a detail panel, Advanced mode). That is
 * deliberately gone: on desktop the plan lives in the Easy panel and nowhere
 * else, so it never hops surfaces as the user toggles a panel or opens a file.
 * A test here failing after someone re-adds a visibility branch is the point.
 */
describe('planBelongsToChat', () => {
  test('desktop: the Easy panel owns the plan', () => {
    expect(planBelongsToChat({ isMobile: false })).toBe(false);
  });

  test('mobile: the transcript owns the plan', () => {
    // Structural, not a fallback — under 768px `session-action-panel-column`
    // returns null, so no panel column exists at any time.
    expect(planBelongsToChat({ isMobile: true })).toBe(true);
  });

  test('the surface is decided by viewport ALONE — panel state cannot move it', () => {
    // The guard against re-adding a `panelOpen` / `detailOpen` / `panelMode`
    // branch: extra state on the input must not change the answer, because a
    // collapsed or covered panel on desktop is a hidden plan ON PURPOSE.
    const withPanelHidden = {
      isMobile: false,
      panelOpen: false,
      detailOpen: true,
      panelMode: 'advanced',
    } as PlanSurfaceState;

    expect(planBelongsToChat(withPanelHidden)).toBe(false);
  });

  test('exactly one surface draws the plan at each width', () => {
    // Never both (one live checklist rendered twice), never neither (a session
    // that shows no plan at all).
    for (const isMobile of [false, true]) {
      const chatDraws = planBelongsToChat({ isMobile });
      const panelDraws = !chatDraws;
      expect(chatDraws !== panelDraws).toBe(true);
    }
  });
});

/**
 * The transcript half. `chatPlanAnchorId` only asks WHICH turn once
 * `planBelongsToChat` has said the chat is drawing it at all.
 */
describe('chatPlanAnchorId', () => {
  const messages = [user('u1'), assistant('a1', ['todowrite']), user('u2')];

  test('the panel owns the plan: no turn claims it', () => {
    // Null matches no message id, so every `ownsPlan` downstream is false and
    // the user bubble's column cap relaxes back to `max-w-[80%]` with it.
    expect(chatPlanAnchorId(messages, false)).toBeNull();
  });

  test('the chat owns the plan: the same anchor as before the panel existed', () => {
    expect(chatPlanAnchorId(messages, true)).toBe('u1');
    expect(chatPlanAnchorId(messages, true)).toBe(planAnchorMessageId(messages));
  });

  test('no transcript yet is null either way', () => {
    expect(chatPlanAnchorId(null, true)).toBeNull();
    expect(chatPlanAnchorId(undefined, true)).toBeNull();
    expect(chatPlanAnchorId([], true)).toBeNull();
  });

  test('the scan is skipped entirely when the panel owns the plan', () => {
    // The gate wraps the walk rather than sitting beside it: on a long session
    // `planAnchorMessageId` inspects every part of every message, and that is
    // work with no consumer while the panel is drawing.
    const huge = Array.from({ length: 500 }, (_, i) => user(`u${i}`));
    expect(chatPlanAnchorId(huge, false)).toBeNull();
  });
});
