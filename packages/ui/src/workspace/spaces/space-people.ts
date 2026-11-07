'use client';

import type { ProjectSpace, ProjectSpaceMember } from '@kortix/sdk';
import { useProjectConfig, useProjectSpaceMembers, useProjectSpaces } from '@kortix/sdk/react';
import { useCallback, useMemo } from 'react';

import { useTranslations } from '../../i18n';
import { useAccountMembers } from '../../internal/account-hub/use-account-members';
import { useBillingAccountId } from '../../internal/stores/billing-account-context';
import { useUiViewerId } from '../../providers/ui-provider';
import { mentionSlug } from './space-mention-source';
import { agentLabel } from './space-timeline';

/** One name a message may `@`-mention, and every token that names it. */
export interface MentionName {
  label: string;
  tokens: readonly string[];
}

/**
 * `text` with each `@token` that names a person or an agent replaced by
 * `@<display name>` (pure): `@ana@example.com` → `@Ana Lima`, `@worker` →
 * `@Worker`. Tokens are matched case-insensitively, at the start or after
 * whitespace, with trailing punctuation left in place. Unknown tokens stay.
 */
export function withMentionNames(text: string, names: readonly MentionName[]): string {
  if (!text.includes('@') || names.length === 0) return text;
  const byToken = new Map<string, string>();
  for (const name of names) for (const token of name.tokens) if (token) byToken.set(token.toLowerCase(), name.label);
  return text.replace(/(^|\s)@([^\s]+)/g, (whole, lead: string, raw: string) => {
    const word = raw.replace(/[.,;:!?)\]}'"]+$/, '');
    const label = byToken.get(word.toLowerCase());
    return label ? `${lead}@${label}${raw.slice(word.length)}` : whole;
  });
}

/**
 * The project's people and agents as mention names: a person by email, its
 * local part and the display name as one token; an agent by its name. The
 * reads the sidebar and the space view already make (`#general`'s members,
 * the account directory, the project config).
 */
export function useMentionNames(projectId: string): (text: string) => string {
  const spaces = useProjectSpaces(projectId);
  const general = spaces.data?.find((space) => space.is_default)?.space_id;
  const members = useProjectSpaceMembers(projectId, general);
  const directory = useAccountMembers(useBillingAccountId());
  const config = useProjectConfig(projectId);
  const names = useMemo<MentionName[]>(() => {
    const emails = new Map((directory.data ?? []).map((member) => [member.user_id, member.email]));
    const people = (members.data?.members ?? []).map((member) => {
      const email = emails.get(member.user_id) ?? null;
      return { label: member.name, tokens: [email ?? '', email?.split('@')[0] ?? '', mentionSlug(member.name)] };
    });
    const agents = (config?.agents ?? []).map((agent) => ({ label: agentLabel(agent.name), tokens: [agent.name] }));
    return [...people, ...agents];
  }, [members.data, directory.data, config]);
  return useCallback((text: string) => withMentionNames(text, names), [names]);
}

/** A member's possible short names: the first word of the display name, and the whole name. */
function shortNames(member: Pick<ProjectSpaceMember, 'name'>): string[] {
  const first = member.name.trim().split(/\s+/)[0] ?? '';
  return [...new Set([first, member.name.trim()].filter(Boolean))];
}

/**
 * The other person of a two-person private space that "Message" made, seen
 * from the viewer's side, or null. Such a space keeps its generated name
 * ("Ana and Bo", `spaces.profile.dmSpaceName`, either order); a space named
 * anything else keeps its own name.
 */
export function otherPersonOf(
  space: Pick<ProjectSpace, 'kind' | 'visibility' | 'name'>,
  members: readonly ProjectSpaceMember[] | undefined,
  viewerId: string | undefined,
  generatedName: (a: string, b: string) => string,
): ProjectSpaceMember | null {
  if (space.kind !== 'channel' || space.visibility !== 'private' || !members || members.length !== 2 || !viewerId) return null;
  const me = members.find((member) => member.user_id === viewerId);
  const other = members.find((member) => member.user_id !== viewerId);
  if (!me || !other) return null;
  const name = space.name.trim().toLowerCase();
  for (const a of shortNames(me)) {
    for (const b of shortNames(other)) {
      if (generatedName(a, b).toLowerCase() === name || generatedName(b, a).toLowerCase() === name) return other;
    }
  }
  return null;
}

/** `otherPersonOf` for one space, with its members read (private channels only). */
export function useOtherPerson(projectId: string, space: ProjectSpace | null | undefined): ProjectSpaceMember | null {
  const t = useTranslations('spaces.profile');
  const viewerId = useUiViewerId();
  const twoPerson = space?.kind === 'channel' && space.visibility === 'private';
  const members = useProjectSpaceMembers(projectId, twoPerson ? space.space_id : null);
  return useMemo(
    () => (space && twoPerson ? otherPersonOf(space, members.data?.members, viewerId, (a, b) => t('dmSpaceName', { a, b })) : null),
    [space, twoPerson, members.data, viewerId, t],
  );
}
