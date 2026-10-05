import type { ReleaseOutcome } from '../projects/session-lifecycle/release-runtime-question';

/**
 * Releasing a channel session's blocking `question` call, from the server.
 *
 * The agent's `question` tool blocks until answered. In a chat channel the
 * answer arrives later as an ordinary message — a NEW turn — so the call must
 * be released with a sentinel or the turn hangs until the box is parked.
 *
 * That used to happen only inside the sandbox, gated on SLACK_THREAD_TS /
 * SLACK_CHANNEL_ID in BOTH harnesses (open-code/boot.ts and pi/relay.ts). A
 * Teams session carries MS_TEAMS_* instead, so a Teams agent that asked a
 * question hung after its card was posted. The daemons are image-baked, so
 * fixing them reaches only new sandboxes.
 *
 * This runs in `POST /turn-question`, which both harnesses already call with
 * the runtime's own question id. It reaches every existing sandbox on the next
 * API deploy, and it is harness-agnostic: real OpenCode and the pi harness both
 * serve `POST /question/:id/reply` with the same contract.
 *
 * It also fixes Slack. The old daemon's Slack sentinel ended with "Next time,
 * just ask with `slack send` rather than the question tool" — the opposite of
 * what the Slack turn prompt now tells the agent. The server releases FIRST
 * (inside the request the daemon is still awaiting), so its sentinel is the one
 * the agent reads; the daemon's own late release returns 404 and is ignored.
 */

export type ChatChannel = 'teams' | 'slack';

/**
 * Which chat channel a session belongs to, from its own metadata — the
 * authoritative record, set once at creation. The live-turn row is NOT used:
 * `platformFor` reads that row and defaults to Slack when it is missing, which
 * would misroute a Teams session whose turn had already closed.
 */
export function channelOfSessionMetadata(metadata: unknown): ChatChannel | null {
  const m =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  if (m.source === 'teams' || (m.teams !== null && typeof m.teams === 'object')) return 'teams';
  if (m.source === 'slack' || (m.slack !== null && typeof m.slack === 'object')) return 'slack';
  return null;
}

/**
 * What the agent reads as the answer to its own question. Two cases, because
 * they need opposite instructions:
 *
 * - POSTED: the user can answer, and that answer is a new turn. End this one.
 * - NOT POSTED: the user never saw it. Tell the agent so, and send it back to
 *   the channel's own `send`, rather than letting it believe it asked.
 */
export function questionReleaseSentinel(channel: ChatChannel, posted: boolean): string {
  const where = channel === 'teams' ? 'the Teams conversation' : 'the Slack thread';
  if (posted) {
    return (
      `(Posted to ${where}. Questions here are async — the user answers with a tap or ` +
      'a reply, and that reaches you as a NEW turn with full context. Do NOT wait for an ' +
      'answer, and post nothing else: the question is your reply. Just finish this turn now.)'
    );
  }
  const send = channel === 'teams' ? '`teams send`' : '`slack send`';
  return (
    `(This question could NOT be posted to ${where}, so the user has not seen it. Ask it ` +
    `in plain words with ${send}, then finish this turn — their reply reaches you as a NEW turn.)`
  );
}

export async function releaseChannelQuestion(input: {
  sessionId: string;
  requestId: string;
  questionCount: number;
  channel: ChatChannel;
  posted: boolean;
}): Promise<ReleaseOutcome> {
  const sentinel = questionReleaseSentinel(input.channel, input.posted);
  // One answer per question: each is the list of selected labels.
  const answers = Array.from({ length: Math.max(1, input.questionCount) }, () => [sentinel]);
  // Imported lazily: the channel modules keep no static edge into the
  // session-lifecycle engine (the rule teams/turn.ts and teams/stop.ts follow
  // for `abortRuntimeTurn`). `channelOfSessionMetadata` above stays pure, so
  // turn-relay.ts can import this file without pulling the engine in.
  const { releaseRuntimeQuestion } = await import(
    '../projects/session-lifecycle/release-runtime-question'
  );
  const outcome = await releaseRuntimeQuestion(input.sessionId, input.requestId, answers);
  if (outcome === 'unreachable') {
    // Not fatal: a new-image daemon releases on its own. Logged because an old
    // Teams sandbox has no other release, and this line is how a hang is traced.
    console.warn('[turn-question] could not release the runtime question', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      channel: input.channel,
    });
  }
  return outcome;
}
