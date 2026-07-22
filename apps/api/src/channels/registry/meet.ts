/**
 * Meet (Recall.ai notetaker bot — Google Meet/Zoom/Teams) connector provider
 * descriptor. Ports the behavior of the old
 * `/channels/meet/{voices,name,voice,speak}` handlers onto the uniform
 * ConnectorProviderDescriptor contract. Capability behavior — including
 * status codes (400/404/502/503) — is preserved exactly.
 *
 * Meet is capability-heavy and lifecycle-light: unlike Slack/Teams/Email there
 * was never an install/OAuth/webhook flow, only project-scoped config (bot
 * name + voice) and two runtime actions (preview a voice, speak in a live
 * call). That reshapes the lifecycle methods:
 *   - getInstallation returns Meet's current config (the old GET /voices
 *     payload) — that config IS Meet's "installation" view — or null when the
 *     `meet` experimental flag is off (never 403 a read; matches the
 *     `isEnabled` contract email.ts follows).
 *   - connect sets bot name and/or voice from the body. There's no upstream
 *     resource to provision, so this is the closest thing Meet has to
 *     "connecting" — it funnels config-setting through the one onboarding
 *     route instead of adding a bespoke provisioning step. Gated on the
 *     experimental flag since it's new descriptor-only surface with no old
 *     route to match behavior against.
 *   - disconnect is a no-op: there is no external install, credential, or
 *     connector-materialized resource to tear down (the old code had no
 *     disconnect route at all for Meet).
 *
 * IMPORTANT behavior notes:
 *   - The five capabilities below are 1:1 ports of the old routes and, like
 *     those routes, do NOT re-check the `meet` experimental flag (the old
 *     handlers never did — only the unified list/mode/installation surface
 *     needs the flag to decide what to show). Adding a gate here would be a
 *     behavior change, not a port.
 *   - `setName`/`setVoice` were gated by PROJECT_CUSTOMIZE_WRITE in the old
 *     routes, so they use access:'customize' — the generic dispatch route maps
 *     that lane to PROJECT_CUSTOMIZE_WRITE, an exact match with no leaf change.
 *   - `speak` was gated by PROJECT_CONNECTOR_WRITE in the old route, so
 *     access:'write' here is an exact match, no leaf change.
 *   - `voices`/`previewVoice` required only project membership (no capability
 *     leaf), so they use access:'member' — an exact match.
 *   - `previewVoice`'s voiceId moved from a path param
 *     (`/voices/:voiceId/preview`) to the JSON body, since the generic route
 *     is `.../actions/{action}` with no room for a nested path param. Callers
 *     must now send `{ "voiceId": "..." }` (or `voice_id`) in the POST body.
 */
import { config } from '../../config';
import { resolveExperimentalFeature } from '../../experimental/features';
import { previewVoiceB64, speakInMeeting } from '../meet-tts';
import { isMeetVoice, setProjectBotName, setProjectVoice } from '../meet-voices';
import { MEET_DEFAULT_SLUG, buildMeetVoicesPayload } from '../meet/connect';
import { ChannelError, type ChannelContext, type ConnectorProviderDescriptor } from './descriptor';

function isEnabled(metadata: unknown): boolean {
  return resolveExperimentalFeature(metadata, 'meet');
}

/** Shared 403 for a disabled experimental meet channel. */
function assertEnabled(ctx: ChannelContext): void {
  if (!isEnabled(ctx.metadata)) {
    throw new ChannelError(403, {
      error: 'Meetings is experimental and must be enabled for this project',
    });
  }
}

export const meetDescriptor: ConnectorProviderDescriptor = {
  platform: 'meet',
  label: 'Google Meet',
  reservedSlug: MEET_DEFAULT_SLUG,
  defaultSlug: MEET_DEFAULT_SLUG,
  direction: 'inbound',
  isEnabled,

  async getMode(ctx) {
    const enabled = isEnabled(ctx.metadata);
    return {
      provider: 'recall',
      enabled,
      managed_available: enabled && Boolean(config.RECALL_API_KEY),
      speak_enabled: enabled && Boolean(config.ELEVENLABS_API_KEY),
    };
  },

  async getInstallation(ctx, _slug) {
    // Disabled channel reads as "no install" (never 403 a read), matching the
    // isEnabled/getInstallation contract email.ts follows.
    if (!isEnabled(ctx.metadata)) return null;
    return buildMeetVoicesPayload(ctx.projectId);
  },

  async connect(ctx, _slug, body) {
    assertEnabled(ctx);
    const input = (body ?? {}) as { name?: string; bot_name?: string; voice?: string };
    const name = input.name ?? input.bot_name;
    if (typeof name === 'string' && name.trim()) {
      await setProjectBotName(ctx.projectId, name);
    }
    if (typeof input.voice === 'string' && input.voice) {
      if (!isMeetVoice(input.voice)) throw new ChannelError(400, { error: 'unknown voice' });
      await setProjectVoice(ctx.projectId, input.voice);
    }
    return buildMeetVoicesPayload(ctx.projectId);
  },

  async disconnect(_ctx, _slug) {
    // No-op: no external install/credential/resource to tear down. The old
    // code had no disconnect route for Meet either.
  },

  capabilities: {
    /** GET the voice catalog + current selection (old GET /meet/voices). */
    voices: {
      method: 'get',
      access: 'member',
      async handler(ctx, _input, _c) {
        return buildMeetVoicesPayload(ctx.projectId);
      },
    },

    /** PUT the bot's display name (old PUT /meet/name). */
    setName: {
      method: 'put',
      access: 'customize',
      async handler(ctx, input, _c) {
        const body = (input ?? {}) as { name?: string; bot_name?: string };
        const name = String(body.name ?? body.bot_name ?? '');
        const saved = await setProjectBotName(ctx.projectId, name);
        return { ok: true, bot_name: saved };
      },
    },

    /** PUT the meeting voice (old PUT /meet/voice). */
    setVoice: {
      method: 'put',
      access: 'customize',
      async handler(ctx, input, _c) {
        const body = (input ?? {}) as { voice?: string };
        const voiceId = String(body.voice ?? '');
        if (!isMeetVoice(voiceId)) throw new ChannelError(400, { error: 'unknown voice' });
        const voice = await setProjectVoice(ctx.projectId, voiceId);
        return { ok: true, selected: voice.id };
      },
    },

    /**
     * POST a base64 MP3 preview of a stock line in the given voice (old
     * `POST /meet/voices/:voiceId/preview`). Contract change: voiceId now
     * comes from the JSON body (`voiceId` or `voice_id`), not a path param —
     * the generic dispatch route has no room for a nested path segment.
     */
    previewVoice: {
      method: 'post',
      access: 'member',
      async handler(ctx, input, _c) {
        const body = (input ?? {}) as { voiceId?: string; voice_id?: string };
        const voiceId = String(body.voiceId ?? body.voice_id ?? '');
        if (!isMeetVoice(voiceId)) throw new ChannelError(400, { error: 'unknown voice' });
        const r = await previewVoiceB64(voiceId);
        if (!r.ok) throw new ChannelError(r.status, { error: r.error });
        return { ok: true, kind: 'mp3', b64: r.b64 };
      },
    },

    /** POST make the bot speak in a live call (old POST /meet/speak). */
    speak: {
      method: 'post',
      access: 'write',
      async handler(ctx, input, _c) {
        const body = (input ?? {}) as { bot_id?: string; botId?: string; text?: string; voice?: string };
        const botId = String(body.bot_id ?? body.botId ?? '');
        const text = String(body.text ?? '');
        const voice = typeof body.voice === 'string' ? body.voice : undefined;
        if (!botId) throw new ChannelError(400, { error: 'bot_id required' });
        if (!text.trim()) throw new ChannelError(400, { error: 'text required' });
        const r = await speakInMeeting(ctx.projectId, botId, text, voice);
        if (!r.ok) throw new ChannelError(r.status, { error: r.error });
        return { ok: true, voice: r.voice };
      },
    },
  },
};
