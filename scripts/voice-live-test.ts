#!/usr/bin/env bun
/**
 * Live end-to-end test for the voice channel, minus the sandbox.
 *
 * The full agent path (opencode -> MCP -> spawn) needs a snapshot rebake to ship
 * the voice MCP config into a sandbox. Everything BELOW that is testable today,
 * and it is the part that can actually be wrong: the LiveKit room, turn-taking,
 * and the send_prompt hand-off.
 *
 * This drives the same runtime the MCP would, in-process. Audio itself is not
 * this script's problem — LiveKit handles transport and apps/voice-agent (a
 * SEPARATE process) handles STT/LLM/TTS, so this script's only job is to open
 * the room, print the join link a human opens directly in their browser, and
 * watch the transcript. You must have a voice-agent worker running against the
 * same LIVEKIT_URL for the call to actually talk back — see the printed
 * instructions below.
 *
 * Usage:
 *   dotenvx run -f apps/api/.env -- bun scripts/voice-live-test.ts \
 *     --web http://localhost:3000 [--session <real session id>] [--voice alloy]
 *
 * --session makes send_prompt deliver into a REAL Kortix session. Without it the
 * hand-off still runs and is expected to report 'no-session' — which is itself
 * worth seeing, since that path is what keeps the call from hanging when the
 * session is gone.
 *
 * In another terminal, run the worker so the room actually gets an agent:
 *   dotenvx run -f apps/voice-agent/.env --quiet -- pnpm --filter @kortix/voice-agent dev
 */

import { startCall, endCall, readTurns, promptVoiceAgent } from '../apps/api/src/channels/voice/runtime';
import { joinPageUrl } from '../apps/api/src/channels/voice/livekit';
import { mintJoinLink } from '../apps/api/src/channels/voice/join-links';
import { kortixSay } from '../apps/api/src/channels/voice/utterance';

interface Args {
  web?: string;
  session?: string;
  voice?: string;
  project?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const v = argv[i + 1];
    if (f === '--web' && v) (a.web = v), i++;
    else if (f === '--session' && v) (a.session = v), i++;
    else if (f === '--voice' && v) (a.voice = v), i++;
    else if (f === '--project' && v) (a.project = v), i++;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.web) {
    console.error('Required: --web <base>');
    process.exit(1);
  }

  // A stable, obviously-fake project id keeps things self-consistent without
  // needing a real project row; the LiveKit room and its metadata are only
  // ever checked against themselves and the live call registry.
  const workspaceId = args.project ?? '00000000-0000-4000-8000-000000000000';
  const sessionId = args.session ?? `livetest-${Date.now()}`;
  const callId = sessionId;

  console.log(`project: ${workspaceId}`);
  console.log(`session: ${sessionId}${args.session ? '' : '  (synthetic — send_prompt will report no-session)'}`);
  console.log('');
  console.log('NOTE: this only opens the room. For the call to actually talk back,');
  console.log('run the worker in another terminal:');
  console.log('  dotenvx run -f apps/voice-agent/.env --quiet -- pnpm --filter @kortix/voice-agent dev');
  console.log('');

  console.log('1/3  creating the LiveKit room…');
  const call = await startCall({
    callId,
    workspaceId,
    sessionId,
    botName: 'Kortix',
    voice: args.voice ?? null,
  });
  console.log(`     up. room=${call.room} voice=${call.voice}`);

  const { token } = await mintJoinLink({ callId, workspaceId });
  const joinUrl = joinPageUrl(args.web, token);
  console.log('');
  console.log('2/3  open this in your browser (headphones on):');
  console.log('');
  console.log(`     ${joinUrl}`);
  console.log('');
  console.log('3/3  live. Talk to it. Ctrl-C to stop.');
  console.log('');

  let cursor = 0;
  const poll = setInterval(async () => {
    try {
      const page = await readTurns(callId, cursor);
      for (const t of page.turns) {
        console.log(`  ${t.role === 'agent' ? '🔊 kortix' : '🗣  human '}: ${t.text}`);
      }
      cursor = page.cursor;
    } catch (err) {
      console.error('  [poll error]', err instanceof Error ? err.message : err);
    }
  }, 1500);

  // Wait for the WORKER to actually join the room before speaking an intro —
  // there's no local `sendToRoom` hook to watch anymore (that lived on the old
  // in-process bridge), so this just waits a fixed grace period for the
  // dispatched worker to connect and greet on its own, then nudges once more
  // via the same path a real Kortix turn would use.
  setTimeout(async () => {
    const said = await promptVoiceAgent(
      callId,
      kortixSay(
        'Say exactly this out loud now, then stop: "Hey, Kortix here. I can hear you — just talk normally."',
      ),
    );
    console.log(
      said.delivered
        ? '  [kortix -> call] intro nudge sent'
        : `  [kortix -> call] ${said.reason ?? 'call not live'}`,
    );
  }, 5000);

  const shutdown = async () => {
    clearInterval(poll);
    console.log('\nhanging up…');
    await endCall(callId);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
