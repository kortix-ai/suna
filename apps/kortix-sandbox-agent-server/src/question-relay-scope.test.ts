/**
 * Reporting a question and RESOLVING it are separate decisions.
 *
 * The park-and-restore change made `relayQuestionToApi` run for every session
 * (it used to bail without SLACK_THREAD_TS), so the control plane could persist
 * the ask and it would survive the box being parked. That part is right.
 *
 * What came with it by accident: the sentinel auto-answer below the POST then
 * fired for every session too. That is the "every question is auto-answered
 * even outside Slack" bug the function's own header describes — a dashboard
 * session answers `question.asked` interactively over opencode's SSE, so the
 * blocking call must stay blocked while the box is alive.
 *
 * Seen live on dev 2026-08-05: a web session's agent was told "Posted to the
 * Slack thread" — it was not — and answered "I'll use `slack send` for questions
 * in this environment going forward instead of the `question` tool", i.e. the
 * sentinel talked the agent out of the tool park-and-restore exists to make
 * reliable.
 *
 * Asserted on source: the relay is one branch inside a 4k-line daemon with no
 * seam to import, and what matters is which context each half reads.
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('./main.ts', import.meta.url).pathname).text();

/** `relayQuestionToApi`'s body, up to the next top-level declaration. */
function relayBody(): string {
  const start = SRC.indexOf('async function relayQuestionToApi');
  expect(start).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  const end = rest.indexOf('\n// Relay a turn ending');
  return end > 0 ? rest.slice(0, end) : rest;
}

/** Body with comments stripped — the prose names both helpers. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('relayQuestionToApi', () => {
  const body = code(relayBody());

  test('REPORTS on every session, via the channel-agnostic context', () => {
    // sandboxRelayContext() has no Slack requirement — that ungate is what lets
    // a web session's question be persisted at all.
    expect(body).toContain('sandboxRelayContext()');
    expect(body).toContain('turn-question');
  });

  test('the POST is not gated on a Slack context', () => {
    // The regression this guards: reintroducing `slackRelayContext()` as the
    // early return would silently stop persisting web questions again, and
    // nothing user-visible fails until a box parks.
    const postAt = body.indexOf('turn-question');
    const slackGateAt = body.indexOf('slackRelayContext()');
    expect(slackGateAt).toBeGreaterThan(postAt);
  });

  test('RESOLVES only when a channel carries the reply out of band', () => {
    expect(body).toContain('if (!slackRelayContext())');
  });

  test('the Slack-worded sentinel is unreachable without a Slack context', () => {
    // The false "Posted to the Slack thread" line a web session received.
    const gateAt = body.indexOf('if (!slackRelayContext())');
    const sentinelAt = body.indexOf('Posted to the Slack thread');
    expect(gateAt).toBeGreaterThan(-1);
    expect(sentinelAt).toBeGreaterThan(gateAt);
  });

  test('a non-channel question is left open, not replied to', () => {
    const gateAt = body.indexOf('if (!slackRelayContext())');
    const replyAt = body.indexOf('/reply?directory=');
    expect(replyAt).toBeGreaterThan(gateAt);
  });
});
