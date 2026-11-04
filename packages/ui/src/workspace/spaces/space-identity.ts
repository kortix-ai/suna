import type { ProjectSession, ProjectSpace } from '@kortix/sdk';
import { isMyKortixAgentName } from '@kortix/shared';

import { agentLabel, threadMessageText } from './space-timeline';

/**
 * How a space reads in the Spaces UI (flag `chat`). Spaces only: the data
 * model keeps `kind: 'dm'` rows, and this module draws them as private spaces.
 *
 * - The person's DM with My Kortix is their personal space: "<First>'s space".
 * - Another DM is a private space named by its agent.
 * - A channel is its name.
 */

/** The person's own space: their DM with My Kortix. */
export function isPersonalSpace(space: Pick<ProjectSpace, 'kind' | 'dm_agent_name'>): boolean {
  return space.kind === 'dm' && !!space.dm_agent_name && isMyKortixAgentName(space.dm_agent_name);
}

/** Private to the person: every DM, and a channel set to private. */
export function isPrivateSpace(space: Pick<ProjectSpace, 'kind' | 'visibility'>): boolean {
  return space.kind === 'dm' || space.visibility === 'private';
}

/** The first word of a profile name; null when the profile has none. */
export function viewerFirstName(metadata: Readonly<Record<string, unknown>> | undefined): string | null {
  for (const key of ['full_name', 'name'] as const) {
    const value = metadata?.[key];
    if (typeof value !== 'string') continue;
    const first = value.trim().split(/\s+/)[0];
    // An email in the name field is not a name.
    if (first && !first.includes('@')) return first;
  }
  return null;
}

/**
 * The space's name as people read it. `personal` names the personal space
 * ("Marko's space", or "Your space" when the profile has no name); the
 * caller passes it from its catalog.
 */
export function spaceDisplayName(
  space: Pick<ProjectSpace, 'kind' | 'dm_agent_name' | 'name' | 'slug'>,
  personal: string,
): string {
  if (isPersonalSpace(space)) return personal;
  if (space.kind === 'dm') return agentLabel(space.dm_agent_name ?? space.name);
  return space.name || space.slug || '';
}

/** The avatar tile's text: the initials of the first two words, or the first two letters of one word. */
export function spaceInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '#';
  if (words.length === 1) {
    const [first = '', second = ''] = Array.from(words[0]!);
    return first.toUpperCase() + second.toLowerCase();
  }
  return (Array.from(words[0]!)[0]! + Array.from(words[1]!)[0]!).toUpperCase();
}

/**
 * The sidebar's one-line preview: the newest thread's latest reply, else its
 * first message. Null for a space with no thread.
 */
export function spacePreview(sessions: readonly ProjectSession[]): string | null {
  let newest: ProjectSession | null = null;
  for (const session of sessions) {
    if (!newest || Date.parse(session.updated_at) > Date.parse(newest.updated_at)) newest = session;
  }
  if (!newest) return null;
  const reply = newest.result_excerpt?.trim();
  const text = reply || threadMessageText(newest);
  const line = text.replace(/\s+/g, ' ').trim();
  return line || null;
}

/**
 * The Spaces list, in order: the personal space first, then every other
 * live space the person sees (channels, then their other private spaces),
 * in the server's order.
 */
export function orderSpaces(spaces: readonly ProjectSpace[]): { personal: ProjectSpace | null; others: ProjectSpace[] } {
  const live = spaces.filter((space) => !space.archived_at);
  const personal = live.find(isPersonalSpace) ?? null;
  return { personal, others: live.filter((space) => space !== personal) };
}
