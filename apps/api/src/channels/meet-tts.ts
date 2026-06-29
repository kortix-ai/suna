import { config } from '../config';
import { channelApiBase, channelAuth } from '../executor/channels';
import { type FetchImpl, executeCall } from '../executor/execute';
import { loadMeetTokenForProject } from './install-store';
import { getMeetVoice, resolveProjectVoice } from './meet-voices';

const PREVIEW_LINE =
  "Hi, I'm your Kortix notetaker. I'll take notes during the call and answer when you call my name.";

const ACK_LINES = [
  'Sure, one sec.',
  'Let me check.',
  'Mm-hmm, give me a moment.',
  'Good question — let me see.',
  'On it.',
  'Right, let me look that up.',
];

type Fail = { ok: false; error: string; status: number };
type SpeechOk = { ok: true; b64: string };

const fillerCache = new Map<string, string>();

const httpFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, ok: res.ok, text: () => res.text() };
};

export async function synthesizeSpeechB64(text: string, elevenVoiceId: string): Promise<SpeechOk | Fail> {
  const body = (text ?? '').trim();
  if (!body) return { ok: false, error: 'empty_text', status: 400 };
  if (!config.ELEVENLABS_API_KEY) return { ok: false, error: 'elevenlabs_not_configured', status: 503 };

  const url = `${config.ELEVENLABS_BASE_URL.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(elevenVoiceId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': config.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: body,
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `elevenlabs_${res.status}: ${detail.slice(0, 200)}`, status: 502 };
  }
  return { ok: true, b64: Buffer.from(await res.arrayBuffer()).toString('base64') };
}

async function recallOutputAudio(projectId: string, botId: string, b64: string): Promise<{ ok: true } | Fail> {
  const recallKey = await loadMeetTokenForProject(projectId);
  if (!recallKey) return { ok: false, error: 'recall_not_configured', status: 503 };
  const res = await executeCall({
    binding: { kind: 'http', method: 'POST', path: `/bot/${encodeURIComponent(botId)}/output_audio/` },
    baseUrl: channelApiBase('meet'),
    auth: channelAuth('meet'),
    secret: recallKey,
    args: { kind: 'mp3', b64_data: b64 },
    fetchImpl: httpFetch,
  });
  if (!res.ok) {
    return { ok: false, error: `recall_output_audio_${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`, status: 502 };
  }
  return { ok: true };
}

export async function previewVoiceB64(voiceId: string): Promise<SpeechOk | Fail> {
  return synthesizeSpeechB64(PREVIEW_LINE, getMeetVoice(voiceId).elevenVoiceId);
}

export async function speakInMeeting(
  projectId: string,
  botId: string,
  text: string,
  voiceOverride?: string | null,
): Promise<{ ok: true; voice: string } | Fail> {
  const voice = voiceOverride ? getMeetVoice(voiceOverride) : await resolveProjectVoice(projectId);
  const tts = await synthesizeSpeechB64(text, voice.elevenVoiceId);
  if (!tts.ok) return tts;
  const played = await recallOutputAudio(projectId, botId, tts.b64);
  return played.ok ? { ok: true, voice: voice.id } : played;
}

export async function playAcknowledgement(projectId: string, botId: string): Promise<void> {
  if (!config.ELEVENLABS_API_KEY) return;
  const voice = await resolveProjectVoice(projectId);
  const index = Math.floor(Math.random() * ACK_LINES.length);
  const key = `${voice.elevenVoiceId}:${index}`;

  let b64 = fillerCache.get(key);
  if (!b64) {
    const tts = await synthesizeSpeechB64(ACK_LINES[index]!, voice.elevenVoiceId);
    if (!tts.ok) return;
    b64 = tts.b64;
    fillerCache.set(key, b64);
  }
  await recallOutputAudio(projectId, botId, b64).catch(() => {});
}
