import { loadSlackTokenForProject } from '../install-store';
import { getSlackUserDisplayName, type SlackConversationLabel } from '../slack-api';
import { backfillSlackBindingLabel } from './binding-label';
import type { SlackEvent } from './types';

/**
 * What a person recognizes in one Slack message. A Slack event carries ids
 * only (`U0…`, `C0…`); a Teams activity carries names. The agent prompt and the
 * session card show these labels next to the ids, which stay for operations.
 */
export interface SlackMessageLabels {
  /** `#general`, `Direct message`, or `Group DM: sam, alex`; null when unknown. */
  channel: string | null;
  /** The sender's display name; null when unknown. */
  user: string | null;
  /** The message text with each `<@U…>` mention written `<@U…|Name>`. */
  text: string;
}

const NAME_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_NAMES = 5000;
// ponytail: per-replica memory; move to a shared store if many replicas make the lookups costly.
const userNames = new Map<string, { until: number; name: string | null }>();

/** The longest a message waits for its labels; past it the prompt carries ids only. */
const DEFAULT_BUDGET_MS = 2000;
let budgetMs: number | null = null;

export function setSlackLabelBudgetForTest(ms: number | null): void {
  budgetMs = ms;
}

export function resetSlackUserNamesForTest(): void {
  userNames.clear();
}

async function slackUserName(token: string, teamId: string, userId: string): Promise<string | null> {
  const key = `${teamId}:${userId}`;
  const hit = userNames.get(key);
  if (hit && hit.until > Date.now()) return hit.name;
  const name = await getSlackUserDisplayName(token, userId);
  if (userNames.size >= MAX_CACHED_NAMES) userNames.delete(userNames.keys().next().value!);
  userNames.set(key, { until: Date.now() + (name ? NAME_TTL_MS : MISS_TTL_MS), name });
  return name;
}

/** A mention Slack sent without a label. One pass, no backtracking. */
const UNLABELLED_MENTION = /<@([UW][A-Z0-9]+)>/g;
const MAX_MENTIONS = 10;

function channelLabel(label: SlackConversationLabel): string | null {
  switch (label.type) {
    case 'channel':
    case 'private_channel':
      return label.name ? `#${label.name}` : null;
    case 'im':
      return 'Direct message';
    case 'mpim':
      return label.name ? `Group DM: ${label.name}` : 'Group DM';
    default:
      return null;
  }
}

async function resolve(input: { projectId: string; teamId: string | null | undefined; event: SlackEvent }): Promise<SlackMessageLabels> {
  const { projectId, teamId, event } = input;
  const text = event.text ?? '';
  const token = teamId ? await loadSlackTokenForProject(projectId) : null;
  if (!token || !teamId) return { channel: null, user: null, text };
  const mentioned = [...new Set([...text.matchAll(UNLABELLED_MENTION)].map((m) => m[1]!))].slice(0, MAX_MENTIONS);
  const [binding, user, ...names] = await Promise.all([
    event.channel ? backfillSlackBindingLabel(teamId, event.channel, projectId, token) : null,
    event.user ? slackUserName(token, teamId, event.user) : null,
    ...mentioned.map((id) => slackUserName(token, teamId, id)),
  ]);
  const nameOf = new Map(mentioned.map((id, i) => [id, names[i] as string | null]));
  return {
    channel: binding ? channelLabel(binding as SlackConversationLabel) : null,
    user: (user as string | null) ?? null,
    text: text.replace(UNLABELLED_MENTION, (whole, id: string) => {
      const name = nameOf.get(id);
      return name ? `<@${id}|${name}>` : whole;
    }),
  };
}

/** `work`, or `fallback` once the budget runs out or `work` fails. Never throws. */
async function withinBudget<T>(work: Promise<T>, fallback: T, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((done) => {
        timer = setTimeout(() => done(fallback), budgetMs ?? DEFAULT_BUDGET_MS);
      }),
    ]);
  } catch (err) {
    console.warn(`[slack] ${what} failed (non-fatal)`, err);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The labels of one Slack message, within the budget. Never throws. */
export function slackMessageLabels(input: {
  projectId: string;
  teamId: string | null | undefined;
  event: SlackEvent;
}): Promise<SlackMessageLabels> {
  const fallback: SlackMessageLabels = { channel: null, user: null, text: input.event.text ?? '' };
  return withinBudget(resolve(input), fallback, 'message labels');
}

/** Display names of Slack user ids, within the budget; an id Slack cannot name is absent. Never throws. */
export function slackUserNames(token: string, teamId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].slice(0, MAX_MENTIONS);
  if (unique.length === 0) return Promise.resolve(new Map());
  const work = Promise.all(unique.map((id) => slackUserName(token, teamId, id))).then(
    (names) => new Map(unique.flatMap((id, i) => (names[i] ? [[id, names[i]] as [string, string]] : []))),
  );
  return withinBudget(work, new Map<string, string>(), 'user names');
}
