import { afterEach, describe, expect, mock, test } from 'bun:test';

import { SLACK_STOP_ACTION } from '../channels/slack/stop-action';

// `repaintLivePlan` is the single render path for the live plan message, so it
// is where the Stop button either appears or does not. Kept apart from
// unit-slack-stop.test.ts, which mocks `slack/turn` wholesale and therefore
// cannot reach the real renderer.

const base = {
  token: 'x',
  channel: 'C1',
  ts: '11.11',
  triggerTs: '10.10',
  steps: [],
  expiry: 0,
  finalized: false,
  projectId: 'p',
  teamId: 'T1',
  originatingEvent: {},
};

let captured: Array<Record<string, any>> = [];

const repaint = async (sessionId: string) => {
  // Spread the real module: `mock.module` REPLACES it, and slack-api has many
  // other exports the import graph needs.
  const actual = await import('../channels/slack-api');
  mock.module('../channels/slack-api', () => ({
    ...actual,
    updateBlocks: async (_t: string, _c: string, _ts: string, _x: string, blocks: unknown[]) => {
      captured = blocks as Array<Record<string, any>>;
      return true;
    },
  }));
  const { repaintLivePlan } = await import('../channels/slack/turn');
  captured = [];
  await repaintLivePlan({ ...base, sessionId } as never);
  return captured;
};

afterEach(() => {
  mock.restore();
});

describe('repaintLivePlan — the Stop affordance', () => {
  test('no session yet ⇒ no button, because there is nothing to stop', async () => {
    // The live message is posted before the session exists. A button that
    // cannot name a session would only fail when pressed.
    expect((await repaint('')).map((b) => b.type)).toEqual(['plan']);
  });

  test('once the session is known, the button carries its id', async () => {
    const blocks = await repaint('sess-42');

    expect(blocks.map((b) => b.type)).toEqual(['plan', 'actions']);
    const button = blocks.find((b) => b.type === 'actions')!.elements[0];
    expect(button.action_id).toBe(SLACK_STOP_ACTION);
    expect(button.text.text).toBe('Stop');
    // The block action that comes back names no turn of its own, so the id has
    // to travel on the button.
    expect(button.value).toBe('sess-42');
  });

  test('the plan block itself is unchanged — Stop is additive', async () => {
    const blocks = await repaint('sess-42');
    expect(blocks[0]).toMatchObject({ type: 'plan', tasks: [] });
  });
});
