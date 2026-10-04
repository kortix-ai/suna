import { and, eq } from 'drizzle-orm';
import { chatChannelBindings } from '@kortix/db';
import { db } from '../../lib/db';
import { loadSlackTokenForProject } from '../install-store';
import { describeSlackConversation, type SlackConversationLabel, type SlackConversationType } from '../slack-api';

const SLACK_CONVERSATION_TYPES: ReadonlySet<string> = new Set(['channel', 'private_channel', 'im', 'mpim']);

/** A stored `channel_type`, if it is one this module writes for Slack. */
export function slackConversationType(value: string | null | undefined): SlackConversationType | null {
  return value && SLACK_CONVERSATION_TYPES.has(value) ? (value as SlackConversationType) : null;
}

/**
 * A lookup that named nothing (a deleted channel, a DM whose person Slack
 * cannot name) is not repeated for this long: the settings page polls, and
 * each poll would otherwise ask Slack again for every such binding.
 */
const MISS_TTL_MS = 10 * 60 * 1000;
// ponytail: per-replica memory; move to a shared store if many replicas make the misses costly.
const misses = new Map<string, { until: number; label: SlackConversationLabel }>();

export function resetSlackLabelMissesForTest(): void {
  misses.clear();
}

function rememberMiss(key: string, label: SlackConversationLabel): void {
  const now = Date.now();
  for (const [k, v] of misses) if (v.until <= now) misses.delete(k);
  misses.set(key, { until: now + MISS_TTL_MS, label });
}

/**
 * The label of a bound Slack conversation: its stored name, else Slack's
 * answer, which is stored so the next read costs no Slack call. Never throws.
 *
 * `preloadedToken`: a caller labelling many bindings of one project loads the
 * bot token once (each load decrypts a project secret).
 */
export async function backfillSlackBindingLabel(
  teamId: string,
  channelId: string,
  projectId: string,
  preloadedToken?: string | null,
): Promise<SlackConversationLabel> {
  const unknown: SlackConversationLabel = { name: null, type: null, unavailable: false };
  if (!teamId || !channelId || !projectId) return unknown;
  const where = and(
    eq(chatChannelBindings.platform, 'slack'),
    eq(chatChannelBindings.workspaceId, teamId),
    eq(chatChannelBindings.channelId, channelId),
  );
  try {
    const [row] = await db
      .select({ channelName: chatChannelBindings.channelName, channelType: chatChannelBindings.channelType })
      .from(chatChannelBindings)
      .where(where)
      .limit(1);
    if (!row) return unknown;
    if (row.channelName) return { name: row.channelName, type: slackConversationType(row.channelType), unavailable: false };

    const key = `${teamId}:${channelId}`;
    const miss = misses.get(key);
    if (miss && miss.until > Date.now()) return miss.label;

    const token = preloadedToken !== undefined ? preloadedToken : await loadSlackTokenForProject(projectId);
    if (!token) return unknown;
    const label = await describeSlackConversation(token, channelId);
    const known = {
      ...(label.name ? { channelName: label.name } : {}),
      ...(label.type ? { channelType: label.type } : {}),
    };
    if (Object.keys(known).length > 0) await db.update(chatChannelBindings).set(known).where(where);
    if (!label.name) rememberMiss(key, label);
    return label;
  } catch (err) {
    console.warn('[slack] binding label lookup failed (non-fatal)', err);
    return unknown;
  }
}
