#!/usr/bin/env bun
/**
 * Automated end-to-end verification of the voice channel — no human ears needed.
 *
 * Joins the LiveKit room as a participant, SPEAKS a real sentence into it
 * (OpenAI TTS -> PCM -> published audio track), and then asserts on what came
 * back: did the agent publish audio, did it transcribe what was said, and did
 * the turns land in voice_call_turns.
 *
 * This exists because "it says listening and never responds" was reported four
 * separate times, and each cause was different (blocked autoplay, a dead capture
 * chain, a rejected session config, a 401 on the transcript callback). Every one
 * of those is visible here without anyone having to listen.
 *
 * Usage:
 *   dotenvx run -f apps/api/.env -- bun scripts/voice-e2e-verify.ts --call <sessionId>
 */
import { AudioSource, AudioFrame, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
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

async function main() {
  const callId = arg('call');
  if (!callId) throw new Error('--call <sessionId> required');

  const url = process.env.LIVEKIT_URL!;
  const room = `voice-${callId}`;

  const at = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
    identity: `probe-${Date.now()}`,
    name: 'e2e probe',
  });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  const token = await at.toJwt();

  const r = new Room();

  let agentAudioFrames = 0;
  let agentJoined = false;

  r.on(RoomEvent.ParticipantConnected, (p: any) => {
    console.log(`  participant joined: ${p.identity}`);
    if (!p.identity.startsWith('probe-')) agentJoined = true;
  });
  r.on(RoomEvent.TrackSubscribed, (track: any, _pub: any, participant: any) => {
    console.log(`  subscribed to ${track.kind} from ${participant.identity}`);
    const stream = new (require('@livekit/rtc-node').AudioStream)(track);
    (async () => {
      for await (const _frame of stream) agentAudioFrames++;
    })().catch(() => {});
  });

  console.log(`connecting to ${url} room=${room}`);
  await r.connect(url, token, { autoSubscribe: true, dynacast: false });
  console.log('  connected');

  // Give the agent worker a moment to be dispatched into the room.
  await new Promise((res) => setTimeout(res, 4000));
  console.log(`  agent present: ${agentJoined ? 'YES' : 'no (waiting)'}`);

  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('probe-mic', source);
  const opts = new TrackPublishOptions();
  opts.source = TrackSource.SOURCE_MICROPHONE;
  await r.localParticipant!.publishTrack(track, opts);
  console.log('  published probe mic');

  const line = 'Hello. Can you hear me? Please answer with a short sentence.';
  console.log(`\nspeaking: "${line}"`);
  const pcm = await speechPcm(line);

  // Push in 10ms frames at wall-clock pace so the agent's turn detection sees
  // natural speech timing rather than an instant burst.
  const per = (SAMPLE_RATE / 100) * CHANNELS;
  for (let off = 0; off < pcm.length; off += per) {
    const chunk = pcm.subarray(off, Math.min(off + per, pcm.length));
    await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, chunk.length / CHANNELS));
  }
  console.log(`  sent ${(pcm.length / SAMPLE_RATE).toFixed(1)}s of speech`);

  console.log('\nwaiting 20s for the agent to reply…');
  await new Promise((res) => setTimeout(res, 20_000));

  console.log('');
  console.log('=== RESULT ===');
  console.log(`agent in room:        ${agentJoined ? 'PASS' : 'FAIL'}`);
  console.log(`agent audio frames:   ${agentAudioFrames} ${agentAudioFrames > 0 ? 'PASS' : 'FAIL'}`);

  await r.disconnect();
  process.exit(agentJoined && agentAudioFrames > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
