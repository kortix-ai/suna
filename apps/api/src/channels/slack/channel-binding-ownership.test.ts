import { describe, expect, test } from 'bun:test';

// Source tripwires for the 2026-08-28 Slack misrouting incident.
//
// `chat_channel_bindings` is UNIQUE on (platform, workspace_id, channel_id) —
// ONE project owns a channel, workspace-wide. `ensureProjectChannelBinding` runs
// on EVERY Slack event, before `isOwnBotEvent` and before `classifyEvent`, so it
// fires even for events the project goes on to ignore. With an
// `onConflictDoUpdate` that set `projectId`, any project whose Slack app merely
// observed a channel silently took ownership of it, and the previous owner went
// permanently dark there — no hourglass, no reply, no session, and no row
// anywhere recording why.
//
// Prod, workspace T07FUFNT3RV: `kortix-incident-reporter` (installed
// 2026-08-17) held channel C0AASKRLRBR, where `Kortix Company` had run 71
// sessions through 2026-08-14 and then went silent for 14 days.
//
// Re-assignment is a deliberate act with its own paths — the channel picker and
// `/kortix use` / switch_project, both in interactivity.ts — which is exactly
// why the per-event path must only ever CLAIM AN UNOWNED channel.

const read = (rel: string): Promise<string> =>
  Bun.file(new URL(rel, import.meta.url)).text();

describe('ensureProjectChannelBinding claims, never steals', () => {
  test('the per-event bind cannot overwrite an existing owner', async () => {
    const source = await read('./dispatch.ts');
    const start = source.indexOf('export async function ensureProjectChannelBinding');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('export async function resolveOauthProject', start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    expect(body).toContain('onConflictDoNothing');
    // The exact form that caused the takeover. Never reintroduce it here.
    expect(body).not.toContain('onConflictDoUpdate');
    expect(body).not.toContain('set: { projectId');
  });

  test('the deliberate re-assignment paths still exist and still overwrite', async () => {
    const interactivity = await read('./interactivity.ts');
    // The picker pick and the /kortix use switch are how a channel legitimately
    // moves between projects. If these stop writing projectId, a user can no
    // longer re-point a channel at all — the opposite failure.
    expect(interactivity).toContain('set: { projectId');
  });
});
