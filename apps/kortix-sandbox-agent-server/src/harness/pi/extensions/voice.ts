/**
 * Voice calls with this session from the session page (packages/voice). The
 * call's turns are this session's own turns, so the conversation is its chat;
 * the agent gets the `voice_*` tools to act on its own live call.
 *
 * Registered only while the project's `voice_call` flag is on and the
 * session is top-level (runtime.ts `voiceExtensions`). The package is
 * imported here and only here: a box without the flag loads none of it and
 * opens no port. With it, one relay serves the box on 6902
 * (`KORTIX_VOICE_PORT`), reached from the browser through the sandbox port
 * proxy, and each session binds itself under its Kortix session id.
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent'

export const VOICE_CALL_FLAG = 'voice_call'

/** The voice for one session, `session` being the Kortix session id a call names. */
export function voice(session: string): InlineExtension {
  return {
    name: 'kortix-voice',
    factory: async (pi) => {
      const { attach } = await import('@kortix/voice/kortix')
      attach(pi, session)
    },
  }
}
