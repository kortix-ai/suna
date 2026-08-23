import { describe, expect, test } from 'bun:test';

import {
  TURN_FRAME_IDENTITY_FACTS,
  type TurnFrameListFacts,
  type TurnFrameMemoProps,
  sameTurnFrameProps,
} from './turn-frame-memo';

/**
 * The `TurnFrame` memo comparator, fact by fact. Two things are pinned:
 * (1) a change in anything the frame body reads flips the verdict, and (2) a
 * REBUILT container with the same per-turn value does not — the host makes a
 * new `turnRenderKeys` / `pendingTurnIds` / `inboxRowsByMessageId` per frame.
 */

const ID = 'u2';
const OTHER = 'u1';

/** Identity facts shared by every `facts()` call — as the host's `useMemo` /
 *  `useCallback` / module constants keep them across renders. */
const STABLE = {
  sessionStatus: { type: 'busy' },
  permissions: [] as unknown[],
  questions: [] as unknown[],
  agentNames: [] as string[],
  commandMessages: new Map<string, unknown>(),
  commands: [] as unknown[],
  onPermissionReply: () => {},
  onRewind: () => {},
  onQueueRemove: () => {},
  onQueueSendNow: () => {},
  onQueueRetry: () => {},
};

/** A FRESH props object per call — the host rebuilds the list props (and the
 *  per-turn containers) on every render; only `STABLE` keeps identity. */
function facts(over: Partial<TurnFrameListFacts> = {}): TurnFrameListFacts {
  return {
    sessionId: 'ses',
    sessionStatus: STABLE.sessionStatus,
    permissions: STABLE.permissions,
    questions: STABLE.questions,
    sessionWorking: true,
    workingTurnId: ID,
    planAnchorId: null,
    agentNames: STABLE.agentNames,
    providers: undefined,
    commandMessages: STABLE.commandMessages,
    commands: STABLE.commands,
    disableToolNavigation: false,
    onPermissionReply: STABLE.onPermissionReply,
    onRewind: STABLE.onRewind,
    rewindDisabled: false,
    onRowRender: undefined,
    turnRenderKeys: new Map([[ID, ID]]),
    pendingTurnIds: new Set(),
    interruptedTurnIds: new Set(),
    inboxRowsByMessageId: new Map(),
    queueHeld: false,
    onQueueRemove: STABLE.onQueueRemove,
    onQueueSendNow: STABLE.onQueueSendNow,
    onQueueRetry: STABLE.onQueueRetry,
    ...over,
  };
}

const group = { userMessageID: ID };
const turn = { id: 'turn' };
const pricing = { lookup: true };

function props(
  list: TurnFrameListFacts,
  over: Partial<TurnFrameMemoProps> = {},
): TurnFrameMemoProps {
  return {
    group,
    turn,
    className: 'mt-12',
    contain: true,
    pricingLookup: pricing,
    density: 'normal',
    list,
    ...over,
  };
}

describe('sameTurnFrameProps', () => {
  test('a new list object with the same facts (rebuilt per-turn containers included) is equal', () => {
    expect(sameTurnFrameProps(props(facts()), props(facts()))).toBe(true);
  });

  test('own props: group, turn, className, contain, pricingLookup, density each flip the verdict', () => {
    const a = props(facts());
    expect(sameTurnFrameProps(a, props(a.list, { group: { userMessageID: ID } }))).toBe(false);
    expect(sameTurnFrameProps(a, props(a.list, { turn: { id: 'turn' } }))).toBe(false);
    expect(sameTurnFrameProps(a, props(a.list, { className: 'mt-3' }))).toBe(false);
    expect(sameTurnFrameProps(a, props(a.list, { contain: false }))).toBe(false);
    // `contain` defaults to true: undefined vs true is the same prop.
    expect(sameTurnFrameProps(a, props(a.list, { contain: undefined }))).toBe(true);
    expect(sameTurnFrameProps(a, props(a.list, { pricingLookup: { lookup: true } }))).toBe(false);
    expect(sameTurnFrameProps(a, props(a.list, { density: 'compact' }))).toBe(false);
  });

  test('every identity fact flips the verdict when its identity changes', () => {
    const base = facts();
    const fresh: Record<(typeof TURN_FRAME_IDENTITY_FACTS)[number], unknown> = {
      sessionId: 'ses2',
      permissions: [],
      questions: [],
      agentNames: [],
      providers: {},
      commandMessages: new Map(),
      commands: [],
      disableToolNavigation: true,
      onPermissionReply: () => {},
      onRewind: () => {},
      rewindDisabled: true,
      onRowRender: () => {},
      queueHeld: true,
      onQueueRemove: () => {},
      onQueueSendNow: () => {},
      onQueueRetry: () => {},
    };
    for (const key of TURN_FRAME_IDENTITY_FACTS) {
      const changed = facts({ ...base, [key]: fresh[key] });
      expect([key, sameTurnFrameProps(props(base), props(changed))]).toEqual([key, false]);
    }
  });

  describe('per-turn facts: compared by the value THIS turn derives', () => {
    test('turnRenderKeys: a rebuilt map with the same alias is equal; a new alias is not', () => {
      const a = props(facts());
      expect(
        sameTurnFrameProps(
          a,
          props(
            facts({
              turnRenderKeys: new Map([
                [ID, ID],
                [OTHER, OTHER],
              ]),
            }),
          ),
        ),
      ).toBe(true);
      expect(
        sameTurnFrameProps(a, props(facts({ turnRenderKeys: new Map([[ID, 'opt_1']]) }))),
      ).toBe(false);
    });

    test('pendingTurnIds: only this turn reads, and only while the session works', () => {
      const a = props(facts());
      expect(sameTurnFrameProps(a, props(facts({ pendingTurnIds: new Set([OTHER]) })))).toBe(true);
      expect(sameTurnFrameProps(a, props(facts({ pendingTurnIds: new Set([ID]) })))).toBe(false);
      // Pending while idle renders as not pending on both sides.
      const idle = props(facts({ sessionWorking: false, workingTurnId: null }));
      expect(
        sameTurnFrameProps(
          idle,
          props(
            facts({ sessionWorking: false, workingTurnId: null, pendingTurnIds: new Set([ID]) }),
          ),
        ),
      ).toBe(true);
    });

    test('interruptedTurnIds / inboxRowsByMessageId / planAnchorId: this turn only', () => {
      const a = props(facts());
      expect(sameTurnFrameProps(a, props(facts({ interruptedTurnIds: new Set([OTHER]) })))).toBe(
        true,
      );
      expect(sameTurnFrameProps(a, props(facts({ interruptedTurnIds: new Set([ID]) })))).toBe(
        false,
      );
      const row = { id: 'prompt' };
      expect(
        sameTurnFrameProps(a, props(facts({ inboxRowsByMessageId: new Map([[OTHER, row]]) }))),
      ).toBe(true);
      expect(
        sameTurnFrameProps(a, props(facts({ inboxRowsByMessageId: new Map([[ID, row]]) }))),
      ).toBe(false);
      const withRow = props(facts({ inboxRowsByMessageId: new Map([[ID, row]]) }));
      expect(
        sameTurnFrameProps(withRow, props(facts({ inboxRowsByMessageId: new Map([[ID, row]]) }))),
      ).toBe(true);
      expect(
        sameTurnFrameProps(
          withRow,
          props(facts({ inboxRowsByMessageId: new Map([[ID, { id: 'prompt' }]]) })),
        ),
      ).toBe(false);
      expect(sameTurnFrameProps(a, props(facts({ planAnchorId: OTHER })))).toBe(true);
      expect(sameTurnFrameProps(a, props(facts({ planAnchorId: ID })))).toBe(false);
    });

    test('workingTurnId / sessionWorking: the products `working` and `pending`, not the flags', () => {
      // A settled turn: the session-wide flip does not reach it.
      const settled = props(facts({ workingTurnId: OTHER, sessionWorking: true }));
      expect(
        sameTurnFrameProps(settled, props(facts({ workingTurnId: OTHER, sessionWorking: false }))),
      ).toBe(true);
      // The working turn: the flip is its own.
      const working = props(facts({ workingTurnId: ID, sessionWorking: true }));
      expect(
        sameTurnFrameProps(working, props(facts({ workingTurnId: ID, sessionWorking: false }))),
      ).toBe(false);
      // Becoming / ceasing to be the working turn.
      expect(
        sameTurnFrameProps(settled, props(facts({ workingTurnId: ID, sessionWorking: true }))),
      ).toBe(false);
      expect(
        sameTurnFrameProps(working, props(facts({ workingTurnId: null, sessionWorking: true }))),
      ).toBe(false);
    });

    test('sessionStatus: the working turn reads it (retry info); a settled turn does not', () => {
      const settled = props(facts({ workingTurnId: OTHER }));
      expect(
        sameTurnFrameProps(
          settled,
          props(facts({ workingTurnId: OTHER, sessionStatus: { type: 'retry' } })),
        ),
      ).toBe(true);
      const working = props(facts({ workingTurnId: ID }));
      expect(
        sameTurnFrameProps(
          working,
          props(facts({ workingTurnId: ID, sessionStatus: { type: 'retry' } })),
        ),
      ).toBe(false);
    });
  });
});
