/**
 * WHICH pi event closes a Kortix turn.
 *
 * The two systems use "turn" for different things:
 *   pi   — a TURN is ONE provider round. `turn_end` carries a single assistant
 *          message plus its `toolResults`, and the loop then decides whether to
 *          run another round (`shouldStopAfterTurn`,
 *          @earendil-works/pi-agent-core harness/types.d.ts). `agent_end` is
 *          the last event of the RUN.
 *   kortix — a `session_turns` row spans the whole run, prompt to final answer.
 *
 * Relaying on `turn_end` closed the row on the FIRST tool round while the agent
 * was still working: Stop and the working indicator vanished mid-answer and the
 * box deadline was pulled into the idle tail under a live run. It survived
 * testing because a prompt that uses NO tools has exactly one pi turn, so
 * `turn_end` and `agent_end` arrive back to back and the extra relay is a
 * harmless no-op.
 *
 * This pins the predicate itself against the real multi-round event sequence.
 */
import { describe, expect, test } from 'bun:test';

/** The worker's relay predicate, kept in lockstep with worker.ts. */
function relaysTurnEnd(event: { type: string }): boolean {
  return event.type === 'agent_end';
}

/** A two-tool-call run, as pi emits it. */
const RUN = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start' },
  { type: 'message_end' },
  { type: 'turn_end' }, // round 1 — a tool ran; the run continues
  { type: 'turn_start' },
  { type: 'message_start' },
  { type: 'message_end' },
  { type: 'turn_end' }, // round 2 — another tool; still going
  { type: 'turn_start' },
  { type: 'message_end' },
  { type: 'turn_end' }, // round 3 — the final answer
  { type: 'agent_end' }, // THE run ended
];

describe('the turn-end relay fires once per RUN, not once per pi turn', () => {
  test('a three-round tool run relays exactly once', () => {
    expect(RUN.filter(relaysTurnEnd)).toHaveLength(1);
  });

  test('it relays on agent_end, and never on an intermediate turn_end', () => {
    const firstRelayIndex = RUN.findIndex(relaysTurnEnd);
    expect(RUN[firstRelayIndex]?.type).toBe('agent_end');
    // Nothing before the end of the run may close the row.
    expect(RUN.slice(0, firstRelayIndex).some(relaysTurnEnd)).toBe(false);
  });

  test('a no-tool run still relays exactly once', () => {
    const simple = [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_end' },
      { type: 'turn_end' },
      { type: 'agent_end' },
    ];
    expect(simple.filter(relaysTurnEnd)).toHaveLength(1);
  });

  test('the source still uses this predicate', async () => {
    const src = await Bun.file(new URL('./worker.ts', import.meta.url)).text();
    // The relay subscriber must not re-admit turn_end.
    expect(src).toContain("if (event.type !== 'agent_end') return;");
    // The PERSISTENCE subscriber deliberately keeps turn_end: persisting each
    // round as it completes is what makes a killed worker recoverable.
    expect(src).toContain("if (event.type !== 'agent_end' && event.type !== 'turn_end') return;");
  });
});
