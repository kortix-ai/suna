#!/usr/bin/env bun
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  parseArgs,
  out,
  CliError,
  handleError,
  requireEnv,
  validateRequired,
  getEnv,
  kortixProjectId,
  kortixSessionId,
  kortixPost,
} from '../lib';

// Relay a checkpoint or the final answer into this turn's live Slack stream.
// apps/api owns the streamed message; here we just hand it the content.
//   detail → subtitle line under the new task's title (in_progress state).
//   output → result line on the *previous* task as it transitions to complete.
async function relayTurnStream(
  kind: 'step' | 'answer',
  text: string,
  extras: {
    detail?: string;
    output?: string;
    sources?: Array<{ url: string; text: string }>;
    blocks?: unknown[];
  } = {},
): Promise<boolean> {
  const projectId = kortixProjectId();
  const sessionId = kortixSessionId();
  if (!projectId || !sessionId) return false;
  try {
    const r = await kortixPost<{ ok?: boolean }>(`/projects/${projectId}/turn-stream`, {
      session_id: sessionId,
      kind,
      text,
      ...(extras.detail ? { detail: extras.detail } : {}),
      ...(extras.output ? { output: extras.output } : {}),
      ...(extras.sources && extras.sources.length > 0 ? { sources: extras.sources } : {}),
      ...(extras.blocks && extras.blocks.length > 0 ? { blocks: extras.blocks } : {}),
    });
    return r?.ok === true;
  } catch {
    return false;
  }
}

// Parse a repeatable `--source` flag value like `https://example.com|Title`
// into the structured shape the relay expects. Returns [] when missing.
function readSourcesFlag(flags: Record<string, string>): Array<{ url: string; text: string }> {
  const raw = flags.source ?? flags.sources;
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('|');
      if (i <= 0) return { url: line, text: line };
      return { url: line.slice(0, i).trim(), text: line.slice(i + 1).trim() };
    })
    .filter((s) => /^https?:\/\//.test(s.url));
}

function slackApiBase(): string {
  return (getEnv('SLACK_API_URL') ?? 'https://slack.com/api').replace(/\/$/, '');
}

async function apiPost(method: string, body: Record<string, unknown>): Promise<any> {
  const token = requireEnv('SLACK_BOT_TOKEN');
  const res = await fetch(`${slackApiBase()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}

async function apiGet(method: string, params: Record<string, string>): Promise<any> {
  const token = requireEnv('SLACK_BOT_TOKEN');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${slackApiBase()}/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}

async function send(opts: {
  channel: string;
  text?: string;
  threadTs?: string;
  file?: string;
  blocks?: unknown[];
}) {
  const token = requireEnv('SLACK_BOT_TOKEN');

  if (opts.file) {
    if (!existsSync(opts.file)) throw new CliError(`File not found: ${opts.file}`);
    const fileData = readFileSync(opts.file);
    const fileName = opts.file.split('/').pop() || 'file';

    const getUrlRes = await fetch(`${slackApiBase()}/files.getUploadURLExternal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ filename: fileName, length: String(fileData.length) }),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.json()) as any;
    if (!getUrlRes.ok) throw new CliError(getUrlRes.error ?? 'getUploadURL failed');

    const uploadRes = await fetch(getUrlRes.upload_url, {
      method: 'POST',
      body: fileData,
      signal: AbortSignal.timeout(60_000),
    });
    if (!uploadRes.ok) throw new CliError(`Upload failed: ${uploadRes.status}`);

    const completeBody: Record<string, unknown> = {
      files: [{ id: getUrlRes.file_id, title: fileName }],
      channel_id: opts.channel,
    };
    if (opts.text) completeBody.initial_comment = opts.text;
    if (opts.threadTs) completeBody.thread_ts = opts.threadTs;
    const completeRes = await apiPost('files.completeUploadExternal', completeBody);
    if (!completeRes.ok) throw new CliError(completeRes.error ?? 'completeUpload failed');
    return { ok: true, files: completeRes.files, channel: opts.channel };
  }

  if (!opts.text && (!opts.blocks || opts.blocks.length === 0)) {
    throw new CliError('Either --text, --blocks, or --file required');
  }
  const body: Record<string, unknown> = { channel: opts.channel, mrkdwn: true };
  body.text = opts.text ?? deriveFallbackText(opts.blocks);
  if (opts.blocks && opts.blocks.length > 0) body.blocks = opts.blocks;
  if (opts.threadTs) body.thread_ts = opts.threadTs;
  const data = await apiPost('chat.postMessage', body);
  if (!data.ok) throw new CliError(data.error ?? 'send failed');
  return { ok: true, ts: data.ts, channel: data.channel };
}

function deriveFallbackText(blocks: unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return 'New message';
  for (const block of blocks as Array<Record<string, unknown>>) {
    if (block.type === 'header' || block.type === 'section') {
      const t = (block as { text?: { text?: string } }).text?.text;
      if (typeof t === 'string' && t.trim()) return t.trim().slice(0, 200);
    }
  }
  return 'New message';
}

async function edit(opts: {
  channel: string;
  ts: string;
  text?: string;
  blocks?: unknown[];
}) {
  const body: Record<string, unknown> = {
    channel: opts.channel,
    ts: opts.ts,
    text: opts.text ?? deriveFallbackText(opts.blocks),
  };
  if (opts.blocks && opts.blocks.length > 0) body.blocks = opts.blocks;
  const data = await apiPost('chat.update', body);
  if (!data.ok) throw new CliError(data.error ?? 'edit failed');
  return { ok: true, ts: data.ts, channel: data.channel };
}

async function del(opts: { channel: string; ts: string }) {
  const data = await apiPost('chat.delete', { channel: opts.channel, ts: opts.ts });
  if (!data.ok) throw new CliError(data.error ?? 'delete failed');
  return { ok: true };
}

async function react(opts: { channel: string; ts: string; emoji: string }) {
  const data = await apiPost('reactions.add', { channel: opts.channel, timestamp: opts.ts, name: opts.emoji });
  if (!data.ok) throw new CliError(data.error ?? 'react failed');
  return { ok: true };
}

async function history(opts: { channel: string; limit?: number }) {
  const data = await apiGet('conversations.history', { channel: opts.channel, limit: String(opts.limit ?? 20) });
  if (!data.ok) throw new CliError(data.error ?? 'history failed');
  return { ok: true, messages: data.messages };
}

async function thread(opts: { channel: string; ts: string; limit?: number }) {
  const data = await apiGet('conversations.replies', {
    channel: opts.channel, ts: opts.ts, limit: String(opts.limit ?? 20),
  });
  if (!data.ok) throw new CliError(data.error ?? 'thread failed');
  return { ok: true, messages: data.messages };
}

async function listChannels(opts: { limit?: number }) {
  const data = await apiGet('conversations.list', {
    limit: String(opts.limit ?? 100),
    types: 'public_channel,private_channel',
    exclude_archived: 'true',
  });
  if (!data.ok) throw new CliError(data.error ?? 'channels failed');
  return { ok: true, channels: data.channels };
}

async function channelInfo(opts: { channel: string }) {
  const data = await apiGet('conversations.info', { channel: opts.channel });
  if (!data.ok) throw new CliError(data.error ?? 'channel info failed');
  return { ok: true, channel: data.channel };
}

async function join(opts: { channel: string }) {
  const data = await apiPost('conversations.join', { channel: opts.channel });
  if (!data.ok) throw new CliError(data.error ?? 'join failed');
  return { ok: true, channel: data.channel };
}

async function listUsers(opts: { limit?: number }) {
  const data = await apiGet('users.list', { limit: String(opts.limit ?? 100) });
  if (!data.ok) throw new CliError(data.error ?? 'users failed');
  return { ok: true, members: data.members };
}

async function user(opts: { id: string }) {
  const data = await apiGet('users.info', { user: opts.id });
  if (!data.ok) throw new CliError(data.error ?? 'user failed');
  return { ok: true, user: data.user };
}

async function me() {
  const data = await apiPost('auth.test', {});
  if (!data.ok) throw new CliError(data.error ?? 'auth.test failed');
  return {
    ok: true,
    user_id: data.user_id,
    user: data.user,
    team: data.team,
    team_id: data.team_id,
    bot_id: data.bot_id,
  };
}

async function search(opts: { query: string }) {
  const data = await apiGet('search.messages', { query: opts.query });
  if (!data.ok) throw new CliError(data.error ?? 'search failed');
  return { ok: true, messages: data.messages };
}

async function fileInfo(opts: { fileId: string }) {
  const data = await apiGet('files.info', { file: opts.fileId });
  if (!data.ok) throw new CliError(data.error ?? 'file info failed');
  return { ok: true, file: data.file };
}

async function download(opts: { url: string; out: string }) {
  const token = requireEnv('SLACK_BOT_TOKEN');
  const res = await fetch(opts.url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new CliError(`Download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const dir = opts.out.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(opts.out, Buffer.from(buf));
  return { ok: true, path: opts.out, size: buf.byteLength };
}

function manifest(opts: { url?: string; projectId?: string; name?: string }) {
  const publicUrl = opts.url || getEnv('KORTIX_API_URL');
  const projectId = opts.projectId || kortixProjectId();
  if (!publicUrl) throw new CliError('--url required (or set KORTIX_API_URL)');
  if (!projectId) throw new CliError('--project-id required (or set KORTIX_PROJECT_ID)');

  const requestUrl = `${publicUrl.replace(/\/$/, '')}/v1/webhooks/slack/${projectId}`;
  const m = {
    display_information: {
      name: opts.name ?? 'Kortix',
      description: 'Kortix project bot',
      background_color: '#0a0a0a',
    },
    features: { bot_user: { display_name: opts.name ?? 'kortix', always_online: true } },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read', 'channels:history', 'channels:read', 'channels:join',
          'chat:write', 'chat:write.public', 'files:read', 'files:write',
          'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write',
          'mpim:history', 'mpim:read', 'reactions:read', 'reactions:write', 'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [
          'app_mention', 'message.im', 'message.channels', 'message.groups', 'message.mpim',
          'reaction_added', 'reaction_removed', 'member_joined_channel', 'file_shared',
        ],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return { ok: true, manifest: m, webhook_url: requestUrl };
}

function readTextFlag(flags: Record<string, string>): string | undefined {
  if (flags['text-file']) {
    try { return readFileSync(flags['text-file'], 'utf-8'); }
    catch { throw new CliError(`Cannot read --text-file: ${flags['text-file']}`); }
  }
  return flags.text;
}

function readBlocksFlag(flags: Record<string, string>): unknown[] | undefined {
  let raw: string | undefined;
  if (flags['blocks-file']) {
    try { raw = readFileSync(flags['blocks-file'], 'utf-8'); }
    catch { throw new CliError(`Cannot read --blocks-file: ${flags['blocks-file']}`); }
  } else if (flags.blocks) {
    raw = flags.blocks === '-' ? readFileSync(0, 'utf-8') : flags.blocks;
  }
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new CliError(`--blocks is not valid JSON: ${(err as Error).message}`); }
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { blocks?: unknown }).blocks)
        ? (parsed as { blocks: unknown[] }).blocks
        : null);
  if (!arr) throw new CliError('--blocks must be a JSON array (or `{ "blocks": [...] }`)');
  if (arr.length === 0) throw new CliError('--blocks cannot be empty');
  return arr;
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);
  switch (command) {
    case 'step': {
      const text = (readTextFlag(flags) ?? args[0] ?? '').trim();
      if (!text) throw new CliError('checkpoint text required, e.g. slack step "Reading the logs"');
      // --detail: subtitle line shown under the NEW task while in_progress.
      //          Supports inline `<https://… |label>` mrkdwn links.
      // --output: result line attached to the PREVIOUS task as it completes.
      //          Also supports `<url|label>` mrkdwn.
      // --source URL|TITLE (repeatable, newline-separated): citations
      //          rendered under the closing task's card.
      const detail = flags.detail?.trim() || undefined;
      const output = flags.output?.trim() || undefined;
      const sources = readSourcesFlag(flags);
      const relayed = await relayTurnStream('step', text, { detail, output, sources });
      out({ ok: true, relayed });
      break;
    }
    case 'send': {
      const text = readTextFlag(flags) ?? args[0];
      const blocks = readBlocksFlag(flags);
      // No --channel + no --file → this is the turn answer. Finalizes the
      // live streamed message rather than posting a separate one. --blocks
      // is allowed here: Slack accepts a closing `blocks` chunk on stopStream
      // so the answer can be full Block Kit (header/section/actions/etc.).
      if (!flags.channel && !flags.file) {
        if (!text && (!blocks || blocks.length === 0)) {
          throw new CliError('message text required, e.g. slack send "Done — here is the summary"');
        }
        const fallbackText = (text ?? 'Done.').slice(0, 11000);
        const relayed = await relayTurnStream('answer', fallbackText, {
          blocks: blocks && blocks.length > 0 ? blocks : undefined,
        });
        if (relayed) {
          out({ ok: true, delivered: 'stream', mode: blocks ? 'blocks' : 'text' });
          break;
        }
        throw new CliError('No active Slack turn to answer. To post to a channel, pass --channel.');
      }
      validateRequired(flags, 'channel');
      if (!text && !flags.file && !blocks) {
        throw new CliError('--text, --text-file, --blocks, --blocks-file, and/or --file required');
      }
      out(await send({
        channel: flags.channel!,
        text,
        blocks,
        threadTs: flags.thread,
        file: flags.file,
      }));
      break;
    }
    case 'edit': {
      validateRequired(flags, 'channel', 'ts');
      const text = readTextFlag(flags);
      const blocks = readBlocksFlag(flags);
      if (!text && !blocks) throw new CliError('--text, --text-file, or --blocks required');
      out(await edit({ channel: flags.channel!, ts: flags.ts!, text, blocks }));
      break;
    }
    case 'delete':
      validateRequired(flags, 'channel', 'ts');
      out(await del({ channel: flags.channel!, ts: flags.ts! }));
      break;
    case 'react':
      validateRequired(flags, 'channel', 'ts', 'emoji');
      out(await react({ channel: flags.channel!, ts: flags.ts!, emoji: flags.emoji! }));
      break;
    case 'typing':
      validateRequired(flags, 'channel');
      out({ ok: true, note: 'Slack Web API does not support typing indicators for bots' });
      break;
    case 'history':
      validateRequired(flags, 'channel');
      out(await history({ channel: flags.channel!, limit: flags.limit ? parseInt(flags.limit, 10) : undefined }));
      break;
    case 'thread':
      validateRequired(flags, 'channel', 'ts');
      out(await thread({ channel: flags.channel!, ts: flags.ts!, limit: flags.limit ? parseInt(flags.limit, 10) : undefined }));
      break;
    case 'channels':
      out(await listChannels({ limit: flags.limit ? parseInt(flags.limit, 10) : undefined }));
      break;
    case 'channel-info':
      validateRequired(flags, 'channel');
      out(await channelInfo({ channel: flags.channel! }));
      break;
    case 'join':
      validateRequired(flags, 'channel');
      out(await join({ channel: flags.channel! }));
      break;
    case 'users':
      out(await listUsers({ limit: flags.limit ? parseInt(flags.limit, 10) : undefined }));
      break;
    case 'user':
      validateRequired(flags, 'id');
      out(await user({ id: flags.id! }));
      break;
    case 'me':
      out(await me());
      break;
    case 'search':
      validateRequired(flags, 'query');
      out(await search({ query: flags.query! }));
      break;
    case 'file-info':
      validateRequired(flags, 'file');
      out(await fileInfo({ fileId: flags.file! }));
      break;
    case 'download':
      validateRequired(flags, 'url', 'out');
      out(await download({ url: flags.url!, out: flags.out! }));
      break;
    case 'manifest':
      out(manifest({ url: flags.url, projectId: flags['project-id'], name: flags.name }));
      break;
    case 'ask':
      // `slack ask` was replaced by opencode's native `question` tool. Calling
      // opencode's `question` from any agent turn triggered from Slack
      // surfaces the form in the same thread automatically via the
      // sandbox-side event subscriber. The CLI keeps this case so older
      // workflows fail loud instead of pretending to work.
      throw new CliError(
        '`slack ask` was removed — use opencode\'s built-in `question` tool. ' +
        'The Slack form is rendered automatically by the sandbox\'s opencode-events subscriber.',
      );
    case 'help':
    default:
      console.log(`
slack — Slack Web API adapter

Auth: SLACK_BOT_TOKEN env (injected from project_secrets at sandbox spawn).

Turn commands (use these when answering a Slack message):
  step         "<checkpoint>"            # narrate a live plan step as you work
  send         "<answer>"                # deliver your reply — finalizes the live update

Commands:
  send         (--channel, [--text|--text-file], [--blocks|--blocks-file], [--thread], [--file])
  edit         (--channel, --ts, --text|--text-file|--blocks|--blocks-file)
  delete       (--channel, --ts)
  react        (--channel, --ts, --emoji)
  typing       (--channel)               # no-op on Slack Web API
  history      (--channel, [--limit])
  thread       (--channel, --ts, [--limit])
  channels     ([--limit])
  channel-info (--channel)
  join         (--channel)
  users        ([--limit])
  user         (--id)
  me
  search       (--query)
  file-info    (--file <id>)
  download     (--url, --out)
  manifest     (--url, --project-id, [--name])

Block Kit (rich messages):
  --blocks '[{"type":"header","text":{"type":"plain_text","text":"Hi"}},
              {"type":"section","text":{"type":"mrkdwn","text":"*bold* + _italic_"}},
              {"type":"divider"},
              {"type":"actions","elements":[{"type":"button","text":{"type":"plain_text","text":"OK"},"action_id":"ok"}]}]'
  --blocks-file message.json    # read JSON from a file
  --blocks -                    # read JSON from stdin
  Design visually + copy JSON from: https://app.slack.com/block-kit-builder
  --text is always sent as the notification fallback; if omitted, the first
  section/header text is used.
`);
      break;
  }
}

if (import.meta.main) {
  main().catch(handleError);
}
