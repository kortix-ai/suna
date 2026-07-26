#!/usr/bin/env bun
/**
 * Live end-to-end test for the voice channel, minus the sandbox.
 *
 * The full agent path (opencode -> MCP -> spawn) needs a snapshot rebake to ship
 * the voice MCP config into a sandbox. Everything BELOW that is testable today,
 * and it is the part that can actually be wrong: the LiveKit room, Recall's
 * output_media, turn-taking, and the ask_kortix hand-off.
 *
 * This drives the same runtime the MCP would, in-process, against a real
 * meeting. Audio itself is no longer this script's problem — LiveKit handles
 * transport and apps/voice-agent (a SEPARATE process) handles STT/LLM/TTS, so
 * this script's only job is to open the room, get a page into the meeting
 * that can join it, and watch the transcript. You must have a voice-agent
 * worker running against the same LIVEKIT_URL for the call to actually talk
 * back — see the printed instructions below.
 *
 * Usage:
 *   dotenvx run -f apps/api/.env -- bun scripts/voice-live-test.ts \
 *     --web     https://<web-tunnel-or-http://localhost:3000>    \
 *     --meeting https://meet.google.com/abc-defg-hij             \
 *     [--session <real session id>] [--voice alloy]
 *
 *   # no-bot mode: open the LiveKit page yourself instead of sending a Recall bot
 *   dotenvx run -f apps/api/.env -- bun scripts/voice-live-test.ts \
 *     --web http://localhost:3000 --no-bot
 *
 * --session makes ask_kortix deliver into a REAL Kortix session. Without it the
 * hand-off still runs and is expected to report 'no-session' — which is itself
 * worth seeing, since that path is what keeps the call from hanging when the
 * session is gone.
 *
 * In another terminal, run the worker so the room actually gets an agent:
 *   dotenvx run -f apps/voice-agent/.env --quiet -- pnpm --filter @kortix/voice-agent dev
 */

import { startCall, endCall, readTurns, promptVoiceAgent, getCall } from '../apps/api/src/channels/voice/runtime';
import { bridgePageUrl, mintAccessToken } from '../apps/api/src/channels/voice/livekit';

interface Args {
  noBot?: boolean;
  meeting?: string;
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
    if (f === '--no-bot') a.noBot = true;
    else if (f === '--meeting' && v) (a.meeting = v), i++;
    else if (f === '--web' && v) (a.web = v), i++;
    else if (f === '--session' && v) (a.session = v), i++;
    else if (f === '--voice' && v) (a.voice = v), i++;
    else if (f === '--project' && v) (a.project = v), i++;
  }
  return a;
}

async function recall(path: string, body?: unknown) {
  const key = process.env.RECALL_API_KEY;
  const base = (process.env.RECALL_BASE_URL || 'https://us-west-2.recall.ai/api/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Token ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.web || (!args.meeting && !args.noBot)) {
    console.error('Required: --web <base> and either --meeting <url> or --no-bot');
    process.exit(1);
  }

  // A stable, obviously-fake project id keeps things self-consistent without
  // needing a real project row; the LiveKit room and its metadata are only
  // ever checked against themselves and the live call registry.
  const projectId = args.project ?? '00000000-0000-4000-8000-000000000000';
  const sessionId = args.session ?? `livetest-${Date.now()}`;
  const callId = sessionId;

  console.log(`project: ${projectId}`);
  console.log(`session: ${sessionId}${args.session ? '' : '  (synthetic — ask_kortix will report no-session)'}`);
  console.log('');
  console.log('NOTE: this only opens the room. For the call to actually talk back,');
  console.log('run the worker in another terminal:');
  console.log('  dotenvx run -f apps/voice-agent/.env --quiet -- pnpm --filter @kortix/voice-agent dev');
  console.log('');

  console.log('1/4  creating the LiveKit room…');
  const call = await startCall({
    callId,
    projectId,
    sessionId,
    botId: null,
    botName: 'Kortix',
    voice: args.voice ?? null,
  });
  console.log(`     up. room=${call.room} voice=${call.voice}`);

  const token = await mintAccessToken({ room: call.room, identity: `bridge-${callId}`, name: 'Kortix voice bridge' });
  const pageUrl = bridgePageUrl(args.web, token);
  console.log(`2/4  bridge page: ${pageUrl.slice(0, 90)}…`);

  let botId: string | undefined;

  if (args.noBot) {
    // Isolation mode: same room, no Recall bot. Whatever latency remains here
    // is the floor the design can hit.
    console.log('');
    console.log('3/4  NO-BOT mode — open this in your browser (headphones on):');
    console.log('');
    console.log(`     ${pageUrl}`);
    console.log('');
    console.log('4/4  live. Talk to it. Ctrl-C to stop.');
    console.log('');
  } else {
    console.log('3/4  sending the bot into the meeting…');
    const joined = await recall('/bot/', {
      meeting_url: args.meeting,
      bot_name: 'Kortix',
      output_media: { camera: { kind: 'webpage', config: { url: pageUrl } } },
    });
    if (!joined.ok) {
      console.error(`     join failed (${joined.status}):`, JSON.stringify(joined.data).slice(0, 400));
      await endCall(callId);
      process.exit(1);
    }
    botId = joined.data?.id as string;
    call.botId = botId;
    console.log(`     bot ${botId} — ADMIT IT in the meeting.`);
    console.log('');
    console.log('4/4  live. Talk to it. Transcript below; Ctrl-C to hang up.');
    console.log('     (say "what can you do" — small talk it answers itself;');
    console.log('      ask for real work and it will call send_prompt)');
    console.log('');
  }

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
  setTimeout(() => {
    const said = promptVoiceAgent(
      callId,
      'Say exactly this out loud now, then stop: "Hey, Kortix here. I can hear you — just talk normally."',
    );
    console.log(said ? '  [kortix -> call] intro nudge sent' : '  [kortix -> call] call not live');
  }, 5000);

  const shutdown = async () => {
    clearInterval(poll);
    console.log('\nhanging up…');
    if (!args.noBot && botId) await recall(`/bot/${encodeURIComponent(botId)}/leave_call/`, {});
    await endCall(callId);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
