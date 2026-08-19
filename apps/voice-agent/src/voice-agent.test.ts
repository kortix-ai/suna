import { describe, expect, test } from 'bun:test';
import { ACK_LINES, nextAckLine, resetAckRotation } from './ack';
import { resolveCallContext } from './call-context';
import { buildInstructions } from './instructions';

/**
 * The three things this worker had to stop doing, after one live call cost real
 * money in a loop it could not get out of.
 *
 * A stray transcription artifact ("dog.") led the voice model to assert that the
 * project "is about developing a system involving dogs". That invented claim sat
 * in its OWN conversation history as fact, so every correct answer Kortix sent
 * back contradicted it — and it kept handing the contradiction back to Kortix to
 * resolve, one paid turn at a time, until a human hung up.
 *
 * The invention got in through the ACK. `send_prompt` used to return a string
 * telling the model to say it was checking, so the model composed that sentence
 * — and composed more than that: "Checking the main goals now. The project is
 * about developing a system involving dogs, but I am gathering more details."
 * One utterance, two jobs, the second made up.
 */

describe('the ack is a fixed string, not something the model writes', () => {
  test('every line is short, and none of them promises anything about the answer', () => {
    for (const line of ACK_LINES) {
      expect(line.length).toBeLessThan(40);
      expect(line.trim()).toBe(line);
      // The ack is spoken BEFORE anything is known. A line that mentions the
      // subject, the project, or a finding would be the model's invention
      // problem moved into a constant.
      expect(line.toLowerCase()).not.toContain('project');
      expect(line.toLowerCase()).not.toContain('about');
    }
  });

  test('the rotation cycles in a fixed order and repeats only after exhausting the list', () => {
    resetAckRotation();
    const first = ACK_LINES.map(() => nextAckLine());
    expect(first).toEqual([...ACK_LINES]);

    // The identical sentence every time sounds broken, which is the only reason
    // there is a rotation at all — so consecutive acks must differ.
    resetAckRotation();
    const a = nextAckLine();
    const b = nextAckLine();
    expect(a).not.toBe(b);
  });

  test('the cycle wraps rather than running out', () => {
    resetAckRotation();
    for (let i = 0; i < ACK_LINES.length; i++) nextAckLine();
    expect(nextAckLine()).toBe(ACK_LINES[0]);
  });

  test('it is deterministic — a transcript that has to be explained later can be reproduced', () => {
    resetAckRotation();
    const run1 = [nextAckLine(), nextAckLine(), nextAckLine()];
    resetAckRotation();
    const run2 = [nextAckLine(), nextAckLine(), nextAckLine()];
    expect(run2).toEqual(run1);
  });
});

describe('call-scoped API credentials stay in private worker metadata', () => {
  const roomMetadata = JSON.stringify({
    project_id: 'project-1',
    session_id: 'session-1',
    call_id: 'call-1',
    kortix_api_url: 'https://api.kortix.com',
    bot_name: 'Kortix',
    kortix_api_token: 'public-room-token',
  });

  test('reads the bearer from worker metadata', () => {
    const context = resolveCallContext(
      'voice-call-1',
      roomMetadata,
      JSON.stringify({ kortix_api_token: 'private-worker-token' }),
    );

    expect(context.kortixApiToken).toBe('private-worker-token');
  });

  test('does not accept a bearer from public room metadata', () => {
    expect(() => resolveCallContext('voice-call-1', roomMetadata, undefined)).toThrow(
      'voice-agent: worker metadata is missing kortix_api_token',
    );
  });
});

/**
 * `tools.ts` is asserted by reading its source rather than by executing it:
 * `execute` needs a live `RunContext` (a real `AgentSession`, a `SpeechHandle`
 * and a `FunctionCall`), which cannot be constructed outside a running LiveKit
 * job. What matters here is not reachable by other means and is invisible until
 * production, so it is worth pinning at the source level — the same trick
 * apps/api uses for its one-line connector wirings.
 */
const TOOLS_SOURCE = await Bun.file(new URL('./tools.ts', import.meta.url).pathname).text();

describe('send_prompt speaks the ack itself and gives the model nothing to embellish', () => {
  test('the ack goes through session.say — literal TTS, no LLM step', () => {
    expect(TOOLS_SOURCE).toContain('ctx.session.say(nextAckLine())');
    // generateReply() would run the ack through the model, which is exactly how
    // "the project is about developing a system involving dogs" got appended to
    // "Checking the main goals now."
    expect(TOOLS_SOURCE).not.toContain('generateReply');
  });

  test('a successful hand-off returns nothing, so no follow-up utterance is generated', () => {
    // @livekit/agents sets `replyRequired: toolOutput !== undefined`
    // (voice/generation.js), so returning undefined records the tool output but
    // suppresses the reply. A returned string here would put the model straight
    // back on the microphone with a fresh licence to invent.
    expect(TOOLS_SOURCE).toContain('return undefined;');
  });

  test('the tool no longer hands the model an instruction to compose the ack', () => {
    const banned = [
      'Say one short sentence that you are checking',
      'say one short sentence that you are checking',
    ];
    for (const phrase of banned) expect(TOOLS_SOURCE).not.toContain(phrase);
  });

  test('a refusal is relayed as itself, not reported as an unreachable API', () => {
    // apps/api refuses a second in-flight hand-off with a sentence written to be
    // relayed. Announcing that as "Could not reach Kortix" is false, reads as a
    // fault, and invites the immediate retry the refusal exists to prevent.
    expect(TOOLS_SOURCE).toContain("result.kind === 'refused'");
    expect(TOOLS_SOURCE).toContain('return result.error;');
  });
});

describe('the system prompt stops the two behaviours that fed the loop', () => {
  const prompt = buildInstructions('Kortix');

  test('the old "BIAS HARD TOWARD JUST CALLING send_prompt" is gone', () => {
    // It was right that the model should not interrogate the speaker, and wrong
    // about everything else: read as written, it encourages asking again
    // whenever the model is unsure — which is the loop.
    expect(prompt).not.toContain('BIAS HARD TOWARD JUST CALLING send_prompt');
    expect(prompt).toContain('BIAS TOWARD ACTION, NOT TOWARD ASKING AGAIN');
    // ...while keeping the part that was right.
    expect(prompt).toContain('Do not ask which project, which');
    expect(prompt).toContain('CALL send_prompt with what they said');
  });

  test('it forbids stating a project fact it was not told — the dog rule', () => {
    expect(prompt).toContain('NEVER state a fact about this project');
    expect(prompt).toContain('unless Kortix told you that fact IN THIS CALL');
    expect(prompt).toContain('Never fill a');
    expect(prompt).toContain('never repeat back a stray word from the transcript');
  });

  test('it forbids re-asking, and names one-in-flight as the reason', () => {
    expect(prompt).toContain('NEVER re-ask something already handed over');
    expect(prompt).toContain('One request may be in flight at a time');
    expect(prompt).toContain('that is not an error');
  });

  test('it grants the permission that ends the loop: a later answer beats what it said', () => {
    // Without this, a model holding a false belief cannot accept a contradicting
    // answer, so it asks again to reconcile the two — forever.
    expect(prompt).toContain('WHEN AN ANSWER ARRIVES, IT WINS');
    expect(prompt).toContain('you were wrong');
    expect(prompt).toContain('Never ask Kortix to settle a disagreement');
  });

  test('it tells the model the ack is already spoken, so it does not say it twice', () => {
    expect(prompt).toContain('SPEAKS the "let me check" line itself');
    expect(prompt).toContain('say NOTHING and wait');
  });
});
