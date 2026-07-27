#!/usr/bin/env bun
/**
 * Automated end-to-end verification of the voice channel — no human ears needed.
 *
 * Joins the LiveKit room as a participant and runs TWO arms in the same
 * connection:
 *
 *   1. SILENT arm  — publish a mic track, feed it nothing but silence, and
 *      assert NOTHING durable comes back (this is the negative control).
 *   2. SPEAK arm   — actually speak a sentence (OpenAI TTS -> PCM -> published
 *      audio track) and assert a `voice_call_turns` row shows up whose text
 *      matches what was said (this is the positive control).
 *
 * Running both, back to back, in one invocation is the whole point: this
 * script previously asserted success from a frame-count delta alone, and that
 * assertion passed identically whether the caller spoke a full sentence or
 * said literally nothing — the frames it was counting were the agent's own
 * proactive greeting and intro nudge, which fire on a timer regardless of
 * input. `--silent` existed as an opt-in control a human had to remember to
 * run separately; nobody did, until it was run by hand once and exposed the
 * bug. This version can no longer make that mistake: the silent arm always
 * runs, and a spurious "hit" during it fails the whole run.
 *
 * The durable signal (a DB row whose text overlaps what was actually spoken)
 * is the primary pass criterion for the speak arm, per the same lesson —
 * frame counts are kept as secondary/informational only, because a growing
 * frame count on its own has already been proven to mean nothing.
 *
 * Usage:
 *   dotenvx run -f apps/api/.env --quiet -- \
 *     bun apps/voice-agent/scripts/e2e-verify.ts --call <sessionId> [--token <jwt>]
 *
 *   --call <sessionId>   required — the voice call/session id (room is voice-<id>)
 *   --token <jwt>        optional — a LiveKit access token with roomJoin+publish+
 *                         subscribe on that room. If omitted, one is minted
 *                         in-process via the same helper apps/api uses
 *                         (requires LIVEKIT_API_KEY/SECRET in the env).
 *   --say "<text>"       phrase spoken in the speak arm (default: a plain
 *                         "can you hear me")
 *   --silent             run ONLY the silent (negative-control) arm, standalone
 *                         — for debugging the control itself. Exit 0 means the
 *                         control correctly saw nothing; it never prints
 *                         "CONVERSATION VERIFIED".
 *   --timeout-ms <n>     overall bound on the whole run (default 240000 = 4m).
 *                         A hang anywhere becomes a clean FAIL at this bound
 *                         instead of stalling forever.
 */
import {
  AudioSource,
  AudioFrame,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

// ── apps/api internals, imported straight from source ──────────────────────
// Relative imports resolve against the FILE that declares them, not this
// script's own workspace — once runtime.ts/livekit.ts are loaded, THEIR bare
// imports (drizzle-orm, @kortix/db, livekit-server-sdk, ...) resolve against
// apps/api's own node_modules chain. Same pattern already proven out by
// scripts/voice-full-flow.ts (see that file's header for the full story).
// readTurns is a plain DB query — no per-process registry involved — so it's
// safe to call from this separate probe process even against a call that a
// different, already-running API instance opened.
import { readTurns } from '../../api/src/channels/voice/runtime';
import { mintAccessToken, roomNameForCall } from '../../api/src/channels/voice/livekit';

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;

// ── bounds — every wait in this file is capped so a stuck condition surfaces
// as a FAIL, not a hang. The previous version's quiescence loop had NO upper
// bound (just "6 quiet seconds in a row"), and a run that never went quiet
// stalled for the full 10-minute harness timeout with no diagnostic. ────────
const AGENT_PRESENT_MAX_WAIT_MS = 30_000;
const QUIESCENCE_IDLE_MS = 6_000; // consecutive quiet time required to call it settled
const QUIESCENCE_POLL_MS = 1_000;
const QUIESCENCE_MAX_WAIT_MS = 60_000; // hard cap even if it never settles
const SILENT_ARM_AUDIO_MS = 4_000; // how much silence we feed the mic track
const SILENT_ARM_SETTLE_MS = 12_000; // total window we watch for a false hit
const SPEAK_ARM_REPLY_TIMEOUT_MS = 30_000;
const SPEAK_ARM_POLL_MS = 1_500;
const DEFAULT_OVERALL_TIMEOUT_MS = 240_000;
const FRAME_GROWTH_SLACK = 200; // secondary signal only — see file header

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function speechPcm(text: string): Promise<Int16Array> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'onyx',
      input: text,
      // Raw PCM so it can go straight onto the wire — 24kHz s16le mono.
      response_format: 'pcm',
    }),
  });
  if (!res.ok) throw new Error(`tts failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/** Push PCM onto the track in 10ms frames — captureFrame paces itself to
 * roughly real time, so this naturally produces natural-timed speech rather
 * than an instant burst, which matters for the agent's turn detection.
 *
 * Each chunk is COPIED into a fresh, zero-byteOffset Int16Array — do not pass
 * `pcm.subarray(...)` straight through. `AudioFrame.protoInfo()` in
 * @livekit/rtc-node@0.13.31 (src/audio_frame.ts) builds the FFI pointer as
 * `new Uint8Array(this.data.buffer)`, which reads from byte 0 of the
 * UNDERLYING buffer and ignores `data.byteOffset`/`data.byteLength`
 * entirely. `.subarray()` shares its parent's buffer with a nonzero
 * `byteOffset`, so every chunk after the first was silently sending bytes
 * from the START of the whole `pcm` buffer instead of its own slice —
 * verified live: the worker's per-frame peak-amplitude tap showed every
 * "spoken" frame near the noise floor (~1-45 out of a 32767 range) for the
 * ENTIRE speak arm, VAD never saw START_OF_SPEECH, and no turn was ever
 * detected, while the silent arm still "passed" only because reading the
 * wrong offset out of an all-zero silence buffer is still zero. `Int16Array.
 * from()` allocates a new buffer per chunk (byteOffset 0), which sidesteps
 * the bug regardless of whose fault it technically is. */
async function feedPcm(source: AudioSource, pcm: Int16Array): Promise<void> {
  const per = (SAMPLE_RATE / 100) * CHANNELS;
  for (let off = 0; off < pcm.length; off += per) {
    const chunk = Int16Array.from(pcm.subarray(off, Math.min(off + per, pcm.length)));
    await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, chunk.length / CHANNELS));
  }
}

async function feedSilence(source: AudioSource, ms: number): Promise<void> {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  await feedPcm(source, new Int16Array(samples));
}

// ── crude but deliberate text-overlap match, not an exact-string match —
// STT will not transcribe our TTS output verbatim. Require at least 2
// (or fewer if the phrase is short) content words from what we SAID to show
// up in what got TRANSCRIBED, which is specific enough that greeting text
// ("Hi, how can I help you today?") cannot accidentally satisfy it while
// still tolerating normal STT noise. ────────────────────────────────────────
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'can', 'you', 'please', 'with', 'this', 'that',
  'for', 'are', 'short', 'answer', 'sentence', 'hello', 'hear', 'me',
]);
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
function turnMatchesSpeech(turnText: string, spokenText: string): boolean {
  const spokenWords = new Set(contentWords(spokenText));
  if (spokenWords.size === 0) return false;
  const turnWords = contentWords(turnText);
  const overlap = turnWords.filter((w) => spokenWords.has(w)).length;
  const required = Math.min(2, spokenWords.size);
  return overlap >= required;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms — stuck at: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

interface Turn {
  cursor: number;
  role: string;
  speaker: string | null;
  text: string;
  at: string;
}

async function latestCursor(callId: string): Promise<number> {
  const page = await readTurns(callId, 0, 5000);
  return page.cursor;
}
async function userTurnsSince(callId: string, cursor: number): Promise<Turn[]> {
  const page = await readTurns(callId, cursor, 500);
  return page.turns.filter((t) => t.role === 'user');
}

// ── probe connection ────────────────────────────────────────────────────
interface ProbeState {
  agentJoined: boolean;
  frameCount: number;
}
async function connectProbe(url: string, token: string, room: string): Promise<{ r: Room; source: AudioSource; state: ProbeState }> {
  const r = new Room();
  const state: ProbeState = { agentJoined: false, frameCount: 0 };

  r.on(RoomEvent.ParticipantConnected, (p: any) => {
    console.log(`  participant joined: ${p.identity}`);
    if (!String(p.identity).startsWith('probe-')) state.agentJoined = true;
  });
  r.on(RoomEvent.TrackSubscribed, (track: any, _pub: any, participant: any) => {
    console.log(`  subscribed to ${track.kind} from ${participant.identity}`);
    const stream = new AudioStream(track);
    // AudioStream extends ReadableStream<AudioFrame>; lib.dom's ReadableStream
    // type doesn't declare Symbol.asyncIterator even though it's iterable at
    // runtime (Node/Bun implement it) — cast, don't change the lib config.
    (async () => {
      for await (const _frame of stream as unknown as AsyncIterable<AudioFrame>) state.frameCount++;
    })().catch(() => {});
  });

  console.log(`connecting to ${url} room=${room}`);
  await r.connect(url, token, { autoSubscribe: true, dynacast: false });
  console.log('  connected');

  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('probe-mic', source);
  const opts = new TrackPublishOptions();
  opts.source = TrackSource.SOURCE_MICROPHONE;
  await r.localParticipant!.publishTrack(track, opts);
  console.log('  published probe mic');

  return { r, source, state };
}

/** POLL for dispatch rather than assume a fixed delay — bounded. */
async function waitForAgentPresent(r: Room, state: ProbeState): Promise<boolean> {
  const deadline = Date.now() + AGENT_PRESENT_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    // ParticipantConnected only fires for joins AFTER us, so also sweep
    // whoever is already there — an agent dispatched before we connected is
    // otherwise invisible to the event alone.
    for (const [, p] of (r.remoteParticipants ?? new Map())) {
      if (!String(p.identity).startsWith('probe-')) state.agentJoined = true;
    }
    if (state.agentJoined) return true;
    await sleep(1_000);
  }
  return state.agentJoined;
}

/** WAIT FOR QUIESCENCE, bounded. The agent greets on join and the runtime
 * sends an intro nudge shortly after; both produce audio with nobody having
 * said anything. Measuring a before/after window that overlaps them makes
 * the test pass on silence — this is exactly what happened before. Capped at
 * QUIESCENCE_MAX_WAIT_MS so a greeting that never stops (itself a real bug)
 * fails fast instead of hanging the whole harness. */
async function waitForQuiescence(state: ProbeState): Promise<{ settled: boolean; frames: number }> {
  console.log('\nwaiting for the agent to stop talking on its own…');
  const start = Date.now();
  let lastSeen = -1;
  let quietMs = 0;
  while (quietMs < QUIESCENCE_IDLE_MS) {
    if (Date.now() - start > QUIESCENCE_MAX_WAIT_MS) {
      console.log(`  gave up waiting for quiet after ${QUIESCENCE_MAX_WAIT_MS}ms (still at ${state.frameCount} frames)`);
      return { settled: false, frames: state.frameCount };
    }
    await sleep(QUIESCENCE_POLL_MS);
    if (state.frameCount === lastSeen) {
      quietMs += QUIESCENCE_POLL_MS;
    } else {
      quietMs = 0;
      lastSeen = state.frameCount;
    }
  }
  console.log(`  quiet at ${state.frameCount} frames`);
  return { settled: true, frames: state.frameCount };
}

interface ArmResult {
  ran: boolean;
  ok: boolean;
  detail: string;
}

/** NEGATIVE CONTROL: publish silence, then confirm nothing durable shows up.
 * If this ever fails (a "hit" with nobody speaking), the harness itself is
 * broken and nothing else in this run can be trusted. */
async function runSilentArm(source: AudioSource, state: ProbeState, callId: string): Promise<ArmResult> {
  console.log('\n=== SILENT ARM (negative control) — publishing mic, saying nothing ===');
  const baselineCursor = await latestCursor(callId);
  const framesBefore = state.frameCount;

  await feedSilence(source, SILENT_ARM_AUDIO_MS);
  const remaining = SILENT_ARM_SETTLE_MS - SILENT_ARM_AUDIO_MS;
  if (remaining > 0) await sleep(remaining);

  const hits = await userTurnsSince(callId, baselineCursor);
  const framesAfter = state.frameCount;
  const frameGrowth = framesAfter - framesBefore;

  const clean = hits.length === 0;
  const detail =
    `user turns since baseline=${hits.length}` +
    (hits.length ? ` (e.g. "${hits[0]!.text.slice(0, 80)}")` : '') +
    ` | frames ${framesBefore} -> ${framesAfter} (+${frameGrowth}, informational only)`;
  console.log(`  ${clean ? 'PASS' : 'FAIL'} — ${detail}`);
  return { ran: true, ok: clean, detail };
}

/** POSITIVE CONTROL: actually say something, then confirm a durable row shows
 * up whose text overlaps what was said. This is the primary signal — frame
 * growth is recorded but is NOT what decides pass/fail (see file header). */
async function runSpeakArm(source: AudioSource, state: ProbeState, callId: string, line: string): Promise<ArmResult> {
  console.log(`\n=== SPEAK ARM (positive control) — speaking: "${line}" ===`);
  const baselineCursor = await latestCursor(callId);
  const framesBefore = state.frameCount;

  const pcm = await speechPcm(line);
  await feedPcm(source, pcm);
  console.log(`  sent ${(pcm.length / SAMPLE_RATE).toFixed(1)}s of speech, polling for a matching turn…`);

  const deadline = Date.now() + SPEAK_ARM_REPLY_TIMEOUT_MS;
  let match: Turn | undefined;
  let lastSeenCount = -1;
  while (Date.now() < deadline) {
    const turns = await userTurnsSince(callId, baselineCursor);
    if (turns.length !== lastSeenCount) {
      lastSeenCount = turns.length;
      for (const t of turns) console.log(`    saw user turn: "${t.text.slice(0, 100)}"`);
    }
    match = turns.find((t) => turnMatchesSpeech(t.text, line));
    if (match) break;
    await sleep(SPEAK_ARM_POLL_MS);
  }

  const framesAfter = state.frameCount;
  const frameGrowth = framesAfter - framesBefore;
  const ok = Boolean(match);
  const detail =
    (match
      ? `matched turn cursor=${match.cursor} text="${match.text.slice(0, 100)}"`
      : `no voice_call_turns row matched "${line}" within ${SPEAK_ARM_REPLY_TIMEOUT_MS}ms`) +
    ` | frames ${framesBefore} -> ${framesAfter} (+${frameGrowth}, informational only)`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
  return { ran: true, ok, detail };
}

async function run(): Promise<number> {
  const callId = arg('call');
  if (!callId) throw new Error('--call <sessionId> required');

  const url = process.env.LIVEKIT_URL!;
  const room = roomNameForCall(callId);

  let token = arg('token');
  if (!token) {
    console.log('no --token given — minting one in-process via apps/api\'s livekit helper');
    token = await mintAccessToken({ room, identity: `probe-${Date.now()}`, name: 'e2e-verify probe' });
  }

  const silentOnly = flag('silent');
  const line = arg('say') ?? 'Hello. Can you hear me? Please answer with a short sentence.';

  const { r, source, state } = await connectProbe(url, token, room);

  try {
    const agentPresent = await waitForAgentPresent(r, state);
    console.log(`  agent present: ${agentPresent ? 'YES' : 'NO'}`);

    // Requirement: NEVER report success without a confirmed agent in the room
    // — everything downstream is meaningless otherwise, so bail here rather
    // than run arms that can't possibly mean anything.
    if (!agentPresent) {
      console.log('\n=== RESULT ===');
      console.log('agent present:         FAIL — no agent ever joined the room');
      console.log('\nDEAF — cannot verify anything without a dispatched agent');
      return 1;
    }

    const quiescence = await waitForQuiescence(state);
    if (!quiescence.settled) {
      console.log(
        '  [warn] agent never settled inside the bound — proceeding anyway, but any pass ' +
          'below deserves a second look since the baseline may still include greeting audio.',
      );
    }

    const silentArm = await runSilentArm(source, state, callId);

    let speakArm: ArmResult = { ran: false, ok: false, detail: 'skipped (--silent)' };
    if (!silentOnly) {
      speakArm = await runSpeakArm(source, state, callId, line);
      if (speakArm.ok) {
        // Give the agent's own REPLY to what we said a moment to finish and
        // commit before this probe disconnects. runSpeakArm's own pass
        // criterion is just the durable USER row landing — it returns the
        // instant that shows up, which is often mid-reply. Disconnecting
        // immediately interrupts the in-flight speech (see agent_activity.ts:
        // an interrupted SpeechHandle's assistant-side chat-ctx insert is
        // skipped), so the agent's reply never gets a chance to land as its
        // own ConversationItemAdded row. This wait is purely so a human (or
        // the next inspection step) can see a real reply row in the DB — it
        // does not affect PASS/FAIL, which was already decided above.
        console.log('\n  (waiting a few seconds for the agent\'s reply to finish, non-scoring)');
        await sleep(6_000);
      }
    }

    console.log('\n=== RESULT ===');
    console.log(`agent present:              PASS`);
    console.log(`quiescence settled:         ${quiescence.settled ? 'PASS' : 'WARN (hit bound)'}`);
    console.log(`silent arm (must be quiet): ${silentArm.ok ? 'PASS' : 'FAIL'} — ${silentArm.detail}`);
    if (silentOnly) {
      console.log('\n(silent-only run — this is a standalone check of the negative control itself)');
      console.log(silentArm.ok ? 'SILENT CONTROL OK — correctly saw nothing' : 'SILENT CONTROL BROKEN — saw a hit with nobody speaking');
      return silentArm.ok ? 0 : 1;
    }

    console.log(`speak arm (must match):     ${speakArm.ok ? 'PASS' : 'FAIL'} — ${speakArm.detail}`);

    const overallOk = agentPresent && silentArm.ok && speakArm.ok;
    console.log('');
    if (!silentArm.ok) {
      console.log('DEAF/BROKEN — the silent control produced a false hit; nothing else in this run is trustworthy');
    } else if (!speakArm.ok) {
      console.log('DEAF — agent never produced a durable turn matching our speech');
    } else {
      console.log('CONVERSATION VERIFIED — agent present, silent control clean, spoken turn matched');
    }
    return overallOk ? 0 : 1;
  } finally {
    await r.disconnect().catch(() => {});
  }
}

async function main() {
  const overallTimeoutMs = Number(arg('timeout-ms') ?? DEFAULT_OVERALL_TIMEOUT_MS);
  try {
    const code = await withTimeout(run(), overallTimeoutMs, 'overall run');
    process.exit(code);
  } catch (e) {
    console.error('\nFAILED:', e instanceof Error ? e.message : e);
    // A timeout or thrown error is always a FAIL — never let a hang read as
    // "still verifying" to whatever is watching the exit code.
    process.exit(1);
  }
}

main();
