// Manual probe for Slack's plan-mode streaming API.
//
// Loads the bot token from the project's encrypted secret store, then walks
// through the chat.startStream → chat.appendStream → chat.stopStream lifecycle
// against a real channel so we can see Slack's exact responses.
//
// Run: bun apps/api/scripts/probe-slack-stream.ts <channel> [project_id]

import { createDecipheriv, hkdfSync } from 'node:crypto';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const API_KEY_SECRET = process.env.API_KEY_SECRET || '69696';
const SLACK_API = 'https://slack.com/api';

function fromB64url(s: string): Buffer { return Buffer.from(s, 'base64url'); }

function projectSecretKey(projectId: string): Buffer {
  const key = hkdfSync('sha256',
    Buffer.from(API_KEY_SECRET, 'utf8'),
    Buffer.from(projectId, 'utf8'),
    Buffer.from('kortix-project-secret-v1', 'utf8'),
    32);
  return Buffer.from(key);
}

function decrypt(projectId: string, env: string): string {
  const [v, ivB64, tagB64, ctB64] = env.split(':');
  if (v !== 'v1') throw new Error(`bad envelope: ${v}`);
  const d = createDecipheriv('aes-256-gcm', projectSecretKey(projectId), fromB64url(ivB64));
  d.setAuthTag(fromB64url(tagB64));
  return Buffer.concat([d.update(fromB64url(ctB64)), d.final()]).toString('utf8');
}

async function slack(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

const channel = process.argv[2];
const projectIdArg = process.argv[3];
if (!channel) {
  console.error('Usage: bun probe-slack-stream.ts <channel-id-or-name> [project_id]');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

const installs = projectIdArg
  ? await sql<{ project_id: string; workspace_id: string }[]>`
      SELECT project_id, workspace_id FROM kortix.chat_installs
      WHERE platform='slack' AND project_id=${projectIdArg} LIMIT 1`
  : await sql<{ project_id: string; workspace_id: string }[]>`
      SELECT project_id, workspace_id FROM kortix.chat_installs
      WHERE platform='slack' ORDER BY connected_at DESC LIMIT 1`;

if (installs.length === 0) {
  console.error('no chat_installs row found');
  process.exit(1);
}
const { project_id: projectId, workspace_id: workspaceId } = installs[0];

const [secretRow] = await sql<{ value_enc: string }[]>`
  SELECT value_enc FROM kortix.project_secrets
  WHERE project_id=${projectId} AND name='SLACK_BOT_TOKEN' LIMIT 1`;
if (!secretRow) { console.error('no SLACK_BOT_TOKEN secret for project'); process.exit(1); }
const token = decrypt(projectId, secretRow.value_enc);

const auth = await slack(token, 'auth.test', {});
console.log('--- auth.test ---'); console.log(auth);

const meUserId = auth.user_id;
const teamId = auth.team_id || workspaceId;

// Resolve channel: U-prefix → open DM; C-prefix → use as-is; otherwise look
// up by name via conversations.list.
let channelId: string | null;
if (channel.startsWith('U')) {
  const open = await slack(token, 'conversations.open', { users: channel });
  console.log('--- conversations.open ---'); console.log(open);
  if (!open.ok) process.exit(1);
  channelId = open.channel.id;
  // The DM is "between Saumya and our bot" — recipient_user_id should be the
  // human, not the bot.
} else if (channel.startsWith('C') || channel.startsWith('D') || channel.startsWith('G')) {
  channelId = channel;
} else {
  const list = await slack(token, 'conversations.list', {
    limit: 1000,
    types: 'public_channel,private_channel',
    exclude_archived: true,
  });
  const channels = list.channels ?? [];
  const found = channels.find((c: any) => c.name === channel);
  channelId = found?.id ?? null;
  console.log('--- conversations.list lookup ---');
  console.log({ name: channel, id: channelId });
}
if (!channelId) { console.error('channel not found'); process.exit(1); }

// In a DM, plan-mode streams should be addressed to the human user, not the bot.
const recipientUserId = channel.startsWith('U') ? channel : meUserId;

const triggerMsg = await slack(token, 'chat.postMessage', {
  channel: channelId,
  text: `🧪 stream probe ${new Date().toISOString()}`,
});
console.log('--- trigger postMessage ---'); console.log({ ok: triggerMsg.ok, ts: triggerMsg.ts, error: triggerMsg.error, channel: channelId });
if (!triggerMsg.ok) process.exit(1);
const threadTs: string = triggerMsg.ts;

console.log('\n=== VARIANT A: startStream in thread of trigger msg (our current shape) ===');
const startA = await slack(token, 'chat.startStream', {
  channel: channelId,
  thread_ts: threadTs,
  recipient_user_id: recipientUserId,
  recipient_team_id: teamId,
  task_display_mode: 'plan',
  chunks: [{ type: 'task_update', id: 'step-0', title: 'Probing…', status: 'in_progress' }],
});
console.log(startA);

if (!startA.ok) {
  console.log('\n=== VARIANT B: startStream without thread_ts (top-level in channel) ===');
  const startB = await slack(token, 'chat.startStream', {
    channel: channelId,
    recipient_user_id: recipientUserId,
    recipient_team_id: teamId,
    task_display_mode: 'plan',
    chunks: [{ type: 'task_update', id: 'step-0', title: 'Probing…', status: 'in_progress' }],
  });
  console.log(startB);

  console.log('\n=== VARIANT C: post bot parent, startStream in its own thread ===');
  const parent = await slack(token, 'chat.postMessage', { channel: channelId, text: 'Working on it…' });
  console.log({ parent_ts: parent.ts, parent_ok: parent.ok });
  if (parent.ok) {
    const startC = await slack(token, 'chat.startStream', {
      channel: channelId,
      thread_ts: parent.ts,
      recipient_user_id: recipientUserId,
      recipient_team_id: teamId,
      task_display_mode: 'plan',
      chunks: [{ type: 'task_update', id: 'step-0', title: 'Probing…', status: 'in_progress' }],
    });
    console.log(startC);
  }

  console.log('\n=== VARIANT D: no task_display_mode (default) ===');
  const startD = await slack(token, 'chat.startStream', {
    channel: channelId,
    thread_ts: threadTs,
    recipient_user_id: recipientUserId,
    recipient_team_id: teamId,
    chunks: [{ type: 'markdown_text', text: 'streaming a plain reply' }],
  });
  console.log(startD);

  console.log('\n=== VARIANT E: omit recipient_user_id/team_id ===');
  const startE = await slack(token, 'chat.startStream', {
    channel: channelId,
    thread_ts: threadTs,
    task_display_mode: 'plan',
    chunks: [{ type: 'task_update', id: 'step-0', title: 'Probing…', status: 'in_progress' }],
  });
  console.log(startE);
}

if (startA.ok && startA.ts) {
  const streamTs = startA.ts;

  console.log('\n=== APPEND 1: complete step-0, add step-1 ===');
  const a1 = await slack(token, 'chat.appendStream', {
    channel: channelId,
    ts: streamTs,
    chunks: [
      { type: 'task_update', id: 'step-0', title: 'Probing…', status: 'complete' },
      { type: 'task_update', id: 'step-1', title: 'Searching the docs', status: 'in_progress' },
    ],
  });
  console.log(a1);

  await new Promise((r) => setTimeout(r, 800));

  console.log('\n=== APPEND 2: complete step-1, add step-2 ===');
  const a2 = await slack(token, 'chat.appendStream', {
    channel: channelId,
    ts: streamTs,
    chunks: [
      { type: 'task_update', id: 'step-1', title: 'Searching the docs', status: 'complete' },
      { type: 'task_update', id: 'step-2', title: 'Writing the answer', status: 'in_progress' },
    ],
  });
  console.log(a2);

  await new Promise((r) => setTimeout(r, 800));

  console.log('\n=== STOP: complete step-2 + markdown_text answer ===');
  const stop = await slack(token, 'chat.stopStream', {
    channel: channelId,
    ts: streamTs,
    chunks: [
      { type: 'task_update', id: 'step-2', title: 'Writing the answer', status: 'complete' },
      { type: 'markdown_text', text: '**done.** all three checkpoints showed up.' },
    ],
  });
  console.log(stop);
}

await sql.end();
