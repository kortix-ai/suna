import { createHash } from 'node:crypto';
import type { ArtifactCommentMention } from '@kortix/db';

export function hydrateArtifactCommentMentions(mentions: readonly ArtifactCommentMention[]) {
  return mentions.map((mention) => mention.kind === 'user' ? mention : { ...mention, token: artifactAgentMentionToken(mention.agent_name) });
}

export function artifactAgentMentionToken(name: string): string {
  const suffix = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/.test(name) && name.length <= 58 && !name.startsWith('hash.')
    ? name.toLowerCase()
    : `hash.${createHash('sha256').update(name).digest('hex').slice(0, 40)}`;
  return `@agent.${suffix}`;
}

export function artifactPersonMentionToken(userId: string, email: string | null | undefined, duplicates: ReadonlySet<string>): string {
  const normalized = email?.trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9._+-]{1,63}@[a-z0-9.-]+[a-z0-9]$/.test(normalized)
    && !normalized.startsWith('agent.') && !duplicates.has(normalized) ? `@${normalized}` : `@${userId}`;
}
