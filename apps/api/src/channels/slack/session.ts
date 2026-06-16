import { and, eq } from 'drizzle-orm';
import { chatEventDedup, chatThreads, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { createProjectSession, resolveGitTriggerActor } from '../../projects';
import { deliverPromptToSession } from '../../projects/session-delivery';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { buildSlackTurnEnv, finalizeTurn, saveTurn, startTurn } from './turn';
import type { SlackEnvelope, SlackEvent } from './types';

// Atomically create the durable session for a brand-new Slack thread — or, if a
// concurrent event for the SAME thread is already creating it, JOIN that session
// and deliver this message as a follow-up. Two near-simultaneous first messages
// used to each spin up a session, and the mapping then flipped to the loser,
// orphaning the real one (the "shadow session"). We close that by claiming the
// thread BEFORE creating anything: the claim is a single-winner INSERT … ON
// CONFLICT on the shared chat_event_dedup table (pooler-safe, no new table).
// Exactly one handler wins and creates; the rest wait for its chat_threads row
// and follow up into the same session.
export async function createOrJoinThreadSession(input: {
  projectId: string;
  teamId: string;
  threadId: string;
  envelope: SlackEnvelope;
  event: SlackEvent;
  revived: boolean;
}): Promise<void> {
  const { projectId, teamId, threadId, envelope, event, revived } = input;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  const userId = await resolveGitTriggerActor(project.accountId);
  if (!userId) {
    console.warn('[slack-webhook] no actor for project', projectId);
    return;
  }

  // Claim the thread-create. Loser → wait for the winner's mapping and follow up.
  const claimKey = teamId && threadId ? `slack:threadcreate:${teamId}:${threadId}` : null;
  if (claimKey && !(await claimThreadCreate(claimKey))) {
    const sessionId = await waitForThreadSession(teamId, threadId);
    if (sessionId) {
      await deliverPromptToSession({ sessionId, text: renderFollowUpPrompt(envelope, event) });
    } else {
      console.warn('[slack-webhook] lost thread-create claim but winner never published a session', {
        teamId,
        threadId,
      });
    }
    return;
  }

  // We won the claim (or there is no thread to key on). Re-check the mapping: a
  // winner from a prior, now-expired claim may already own this thread — never
  // create a second session, just follow up into the existing one.
  if (teamId && threadId) {
    const [existing] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, 'slack'),
          eq(chatThreads.workspaceId, teamId),
          eq(chatThreads.threadId, threadId),
        ),
      )
      .limit(1);
    if (existing) {
      await deliverPromptToSession({ sessionId: existing.sessionId, text: renderFollowUpPrompt(envelope, event) });
      return;
    }
  }

  const handle = await startTurn(projectId, teamId, event, 'Spinning up a sandbox');

  const result = await createProjectSession({
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: 'default',
      initial_prompt: renderAgentPrompt(envelope, event, revived),
    },
    enforceAccountCap: false,
    // Slack threads are team-facing — project-visible, not private to the
    // stand-in owner the session is attributed to.
    visibility: 'project',
    metadata: {
      source: 'slack',
      slack: {
        team_id: teamId,
        channel: event.channel,
        user: event.user,
        thread_ts: threadId,
        event_type: event.type,
      },
    },
    // Sandbox-side env the slack skill references. The agent uses these to
    // talk back to the same thread without parsing IDs out of the prompt.
    extraEnvVars: buildSlackTurnEnv(teamId, event),
  });

  if (result.error) {
    console.error('[slack-webhook] createProjectSession failed', result.error.body);
    if (handle) {
      await finalizeTurn(handle, { error: "I couldn't start up just now — try again in a moment." });
    }
    return;
  }

  if (result.row && handle) {
    handle.sessionId = result.row.sessionId;
    await saveTurn(handle);
  }

  if (result.row && teamId && threadId) {
    try {
      // ON CONFLICT DO NOTHING — a thread maps to exactly ONE session for life.
      // Never overwrite an existing mapping (overwriting is exactly what orphaned
      // the live session and produced a reply from a thread you could never find).
      await db
        .insert(chatThreads)
        .values({
          projectId,
          platform: 'slack',
          workspaceId: teamId,
          threadId,
          sessionId: result.row.sessionId,
        })
        .onConflictDoNothing({
          target: [chatThreads.platform, chatThreads.workspaceId, chatThreads.threadId],
        });
    } catch (err) {
      console.warn('[slack-webhook] failed to record chat_threads row', err);
    }
  }
}

// Single-winner claim for "who creates this thread's session", reusing the
// shared chat_event_dedup table (a generic INSERT … ON CONFLICT string-claim —
// pooler-safe, no migration). Returns true iff WE are the first/only claimant.
// Fail-open on a DB hiccup: better a rare duplicate than a dropped message.
async function claimThreadCreate(key: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId: key, expiresAt: new Date(Date.now() + EVENT_DEDUPE_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[slack-webhook] thread-create claim failed (fail-open)', err);
    return true;
  }
}

// Wait briefly for the claim winner to publish its chat_threads mapping so a
// losing concurrent message can be delivered into the same session as a
// follow-up instead of spawning a competitor.
async function waitForThreadSession(teamId: string, threadId: string): Promise<string | null> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const [row] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, 'slack'),
          eq(chatThreads.workspaceId, teamId),
          eq(chatThreads.threadId, threadId),
        ),
      )
      .limit(1);
    if (row) return row.sessionId;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const TURN_INSTRUCTIONS = [
  'How to work:',
  '- **First, load the `kortix-slack` skill** via the `skill` tool. It is the canonical',
  '  reference for posting in Slack — covers step/send semantics, link syntax,',
  '  Block Kit answers, sources, tone, and gotchas. Do not skip it.',
  '- As you go, post a short progress checkpoint before each major step:',
  '    slack step "Reading the incident logs"',
  '  Keep them human and brief — a few per task, not one per command — but DO post',
  '  one right before anything slow (installs, builds, long searches, big edits) so',
  '  the thread always shows fresh, lively progress and never sits silent.',
  '- Attach inline context with mrkdwn links:',
  '    slack step "Reading the logs" --detail "Pulling from <https://datadog.example.com|Datadog>"',
  '  `--detail` is the subtitle under the new step. `<url|label>` becomes a real link.',
  '- When the PREVIOUS step finished with a result, surface it:',
  '    slack step "Drafting summary" --output "Found 3 incidents, 1 P0"',
  '  Add `--source URL|TITLE` (repeatable) to cite the URLs you used.',
  '- **Need to ask the user something? In Slack a question is just a message.**',
  '  Post your question with `slack send` (lay out the choices as a short list, or a',
  '  Block Kit message with bullets), then END your turn. The user\'s reply arrives as',
  '  a normal follow-up message — you receive it as the NEXT turn, with full context,',
  '  and continue from there. Slack threads are async: ask, stop, resume when they reply.',
  '  Do NOT use the built-in `question` tool on a Slack turn — it is a synchronous,',
  '  blocking construct for the web UI; in a Slack thread it just stalls the turn.',
  '- Deliver the answer as a rich Block Kit message whenever the response',
  '  benefits from structure (headers, sections, lists, links, bullets):',
  '    slack send --text "fallback summary" --blocks-file /tmp/answer.json',
  '  The `blocks` JSON follows the Block Kit schema (header, section with mrkdwn,',
  '  divider, context, image, actions). Plain text via `slack send "..."` is fine',
  '  for one-liners, but prefer blocks when there\'s real structure to convey.',
  '- One `slack send` per turn. It finalizes the live stream and can\'t be undone.',
].join('\n');

export function renderFollowUpPrompt(envelope: SlackEnvelope, event: SlackEvent): string {
  const user = event.user ?? 'unknown';
  const text = event.text ?? '';
  return [
    `New message from ${user} in the same Slack thread:`,
    '',
    text,
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}

function renderAgentPrompt(
  envelope: SlackEnvelope,
  event: SlackEvent,
  revived: boolean,
): string {
  const channel = event.channel ?? '?';
  const threadTs = event.thread_ts ?? event.ts ?? '';
  const user = event.user ?? 'unknown';
  const text = event.text ?? '';

  const lines: string[] = [];
  if (revived) {
    lines.push(
      'NOTE: This Slack thread had an earlier conversation, but that session',
      'has ended — you do NOT have its history. Open your reply by briefly',
      'saying you are picking the thread back up without the earlier context.',
      '',
    );
  }
  lines.push(
    "You're answering a message on Slack as a teammate.",
    '',
    `Workspace:  ${envelope.team_id ?? 'unknown'}`,
    `Channel:    ${channel}`,
    `User:       ${user}`,
  );
  if (threadTs) lines.push(`Thread ts:  ${threadTs}`);
  lines.push('', 'Message:', text, '', TURN_INSTRUCTIONS);
  return lines.join('\n');
}
