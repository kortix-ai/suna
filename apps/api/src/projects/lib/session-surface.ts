import type { SessionInvocationSource } from '../session-lifecycle/types';

/**
 * The surfaces a person creates a session from over HTTP. The origin policy
 * (`session-origin.ts`) and the initiator treat all three alike: none of them
 * is a trigger, system or channel source.
 */
export const HUMAN_SESSION_SURFACES: ReadonlySet<SessionInvocationSource> = new Set(['ui', 'cli', 'mobile']);

/**
 * The surface an HTTP session create came through (KRTX-2914), from the
 * client's self-reported `X-Kortix-Client-Version` (`cli/0.14.3`,
 * `mobile/1.2.0`, `web/…`). Self-reported, so it only ever picks a human
 * surface: it can never claim a trigger, system or channel source, and it
 * changes no policy. Anything unknown is `ui`.
 */
export function sessionCreateSurface(clientVersion: string | undefined): SessionInvocationSource {
  const surface = clientVersion?.trim().split('/', 1)[0]?.toLowerCase();
  return surface === 'cli' || surface === 'mobile' ? surface : 'ui';
}
