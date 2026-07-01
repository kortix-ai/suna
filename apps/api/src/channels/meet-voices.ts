import type { Effect } from 'effect';
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { sharedDb as db } from '../shared/effect';

export interface MeetVoice {
  id: string;
  name: string;
  desc: string;
  elevenVoiceId: string;
}

// ElevenLabs default/premade voices (usable on free + paid plans). The classic
// "library" voices (Rachel/Antoni/…) require a paid plan via the API, so we use
// the default set instead. Verify a voice is in `GET /v1/voices` for the account.
export const MEET_VOICES: readonly MeetVoice[] = [
  { id: 'sarah', name: 'Sarah', desc: 'Mature, reassuring US female', elevenVoiceId: 'EXAVITQu4vr4xnSDxMaL' },
  { id: 'adam', name: 'Adam', desc: 'Dominant, firm US male', elevenVoiceId: 'pNInz6obpgDQGcFmaJgB' },
  { id: 'laura', name: 'Laura', desc: 'Upbeat, quirky female', elevenVoiceId: 'FGY2WhTYpPnrIDTdsKH5' },
  { id: 'george', name: 'George', desc: 'Warm, captivating male storyteller', elevenVoiceId: 'JBFqnCBsd6RMkjVDRZzb' },
  { id: 'jessica', name: 'Jessica', desc: 'Playful, bright, warm female', elevenVoiceId: 'cgSgspJ2msm6clMCkdW9' },
  { id: 'brian', name: 'Brian', desc: 'Deep, resonant, comforting male', elevenVoiceId: 'nPczCjzI2devNBz1zQrb' },
];

export const DEFAULT_MEET_VOICE = 'sarah';

export function getMeetVoice(id: string | null | undefined): MeetVoice {
  return (
    MEET_VOICES.find((v) => v.id === id) ??
    MEET_VOICES.find((v) => v.id === DEFAULT_MEET_VOICE) ??
    MEET_VOICES[0]!
  );
}

export function isMeetVoice(id: string): boolean {
  return MEET_VOICES.some((v) => v.id === id);
}

export async function resolveProjectVoice(projectId: string): Promise<MeetVoice> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  const sel = (row?.metadata as Record<string, any> | null)?.meet?.voice;
  return getMeetVoice(typeof sel === 'string' ? sel : null);
}

export async function setProjectVoice(projectId: string, voiceId: string): Promise<MeetVoice> {
  const voice = getMeetVoice(voiceId);
  await mergeMeetMetadata(projectId, { voice: voice.id });
  return voice;
}

export const DEFAULT_MEET_BOT_NAME = 'Kortix Notetaker';

export async function resolveProjectBotName(projectId: string): Promise<string> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  const name = (row?.metadata as Record<string, any> | null)?.meet?.bot_name;
  return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_MEET_BOT_NAME;
}

export async function setProjectBotName(projectId: string, name: string): Promise<string> {
  const clean = name.trim().slice(0, 80) || DEFAULT_MEET_BOT_NAME;
  await mergeMeetMetadata(projectId, { bot_name: clean });
  return clean;
}

export function deriveWakeWord(botName: string): string {
  const first = botName.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  return first || 'kortix';
}

async function mergeMeetMetadata(projectId: string, patch: Record<string, unknown>): Promise<void> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  const meta = ((row?.metadata as Record<string, any> | null) ?? {}) as Record<string, any>;
  const meet = { ...((meta.meet as Record<string, any> | undefined) ?? {}), ...patch };
  await db.update(projects).set({ metadata: { ...meta, meet } }).where(eq(projects.projectId, projectId));
}

export const SILENT_MP3_B64 =
  'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAHAAADjgBQUFBQUFBQUFBQUFBQUG1tbW1tbW1tbW1tbW1tioqKioqKioqKioqKioqoqKioqKioqKioqKioqKjFxcXFxcXFxcXFxcXFxeLi4uLi4uLi4uLi4uLi//////////////////8AAAAATGF2YzYyLjI4AAAAAAAAAAAAAAAAJANpAAAAAAAAA455jai7AAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxFMDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDEfIPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMSmA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxM+DwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';
