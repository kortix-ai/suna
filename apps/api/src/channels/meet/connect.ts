/**
 * Meet (Recall.ai notetaker bot) config helpers, lifted out of the bespoke
 * `/channels/meet/*` route handlers in projects/routes/r4.ts so the connector
 * descriptor (registry/meet.ts) is the single owner of channel behavior. Meet
 * has no onboarding/provisioning step — no OAuth, no inbox, no webhook to
 * create — so unlike email/connect.ts this module doesn't prepare a
 * multi-stage upstream connect; it just holds the one payload builder shared
 * by `getInstallation` and the `voices` capability (same data, two entry
 * points onto the uniform descriptor contract), plus the reserved slug.
 */
import { config } from '../../config';
import {
  DEFAULT_MEET_BOT_NAME,
  MEET_VOICES,
  resolveProjectBotName,
  resolveProjectVoice,
} from '../meet-voices';

/** Default profile slug for the built-in meet channel. */
export const MEET_DEFAULT_SLUG = 'kortix_meet';

export interface MeetVoicesPayload {
  ok: true;
  selected: string;
  bot_name: string;
  default_bot_name: string;
  speak_enabled: boolean;
  voices: { id: string; name: string; desc: string }[];
}

/**
 * The voice picker payload: the predefined catalog + the project's current
 * selection, plus whether speaking is wired (ElevenLabs configured). This is
 * exactly the shape the old `GET /channels/meet/voices` handler returned.
 */
export async function buildMeetVoicesPayload(projectId: string): Promise<MeetVoicesPayload> {
  const [selected, botName] = await Promise.all([
    resolveProjectVoice(projectId),
    resolveProjectBotName(projectId),
  ]);
  return {
    ok: true,
    selected: selected.id,
    bot_name: botName,
    default_bot_name: DEFAULT_MEET_BOT_NAME,
    speak_enabled: Boolean(config.ELEVENLABS_API_KEY),
    voices: MEET_VOICES.map((v) => ({ id: v.id, name: v.name, desc: v.desc })),
  };
}
