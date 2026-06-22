#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
// The published Kortix Executor SDK — baked into the sandbox at the mirrored
// path (/opt/kortix/packages/executor-sdk). Using it here both keeps the shim's
// gateway calls clean AND dogfoods the SDK in a real in-sandbox consumer.
import { ExecutorError, createExecutorClient } from '../../../../packages/executor-sdk/src/index';
import {
  CliError,
  getEnv,
  handleError,
  kortixGet,
  kortixPost,
  kortixProjectId,
  kortixSessionId,
  out,
  parseArgs,
  validateRequired,
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

// Slack Web API methods → their Kortix `channel` connector action paths. The
// shim speaks Slack method names; the Executor speaks connector actions.
//
// Use the reserved platform-owned channel slug first. Projects may define their
// own `[[connectors]] slug="slack"` (often Pipedream Slack), which must not
// shadow the built-in Slack CLI. Keep the legacy `slack` fallback so old API
// deployments / old materialized rows continue to work during rollout.
const SLACK_CONNECTORS = ['kortix_slack', 'slack'] as const;
const METHOD_TO_ACTION: Record<string, string> = {
  'chat.postMessage': 'send_message',
  'chat.update': 'update_message',
  'chat.delete': 'delete_message',
  'reactions.add': 'add_reaction',
  'conversations.history': 'get_history',
  'conversations.replies': 'get_thread',
  'conversations.list': 'list_channels',
  'conversations.info': 'channel_info',
  'conversations.join': 'join_channel',
  'users.list': 'list_users',
  'users.info': 'user_info',
  'auth.test': 'auth_test',
  'search.messages': 'search_messages',
  'files.info': 'file_info',
};

type SlackWebApiResponse = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
};

function requiredFlags<const K extends string>(
  flags: Record<string, string>,
  ...keys: K[]
): Record<K, string> {
  validateRequired(flags, ...keys);
  return Object.fromEntries(keys.map((key) => [key, flags[key] ?? ''])) as Record<K, string>;
}

function optionalInt(value: string | undefined): number | undefined {
  return value ? Number.parseInt(value, 10) : undefined;
}

// The Executor SDK client, built from this sandbox's env. Setting projectId
// makes the SDK use the project-explicit gateway route
// (/executor/projects/:id/call), which accepts the in-sandbox session token.
function executorClient() {
  const apiUrl = getEnv('KORTIX_API_URL');
  const token = getEnv('KORTIX_CLI_TOKEN') ?? getEnv('KORTIX_TOKEN');
  if (!apiUrl || !token) {
    throw new CliError('KORTIX_API_URL / KORTIX_CLI_TOKEN not set — cannot reach the Executor.');
  }
  return createExecutorClient({ apiUrl, token, projectId: kortixProjectId() });
}

// Route a Slack Web API call through the Kortix Executor (via the SDK): the bot
// token is resolved + attached SERVER-SIDE (never in this sandbox), the call is
// audited + policy-gated, and Slack's response comes back as `data`. The gateway
// maps Slack's `{ok:false}` envelope to an error, so the SDK throws on failure
// (surfacing the Slack error); on success it returns `{ ok:true, data:<slack> }`.
// Args keep Slack's native names, so the existing callers + `data.ok` reads are
// unchanged.
async function executorCall(
  method: string,
  args: Record<string, unknown>,
): Promise<SlackWebApiResponse> {
  const action = METHOD_TO_ACTION[method];
  if (!action) throw new CliError(`No Executor action mapped for Slack method "${method}"`);
  let lastErr: ExecutorError | null = null;
  for (const connector of SLACK_CONNECTORS) {
    try {
      const res = await executorClient().call(connector, action, args);
      return (res.data ?? res) as SlackWebApiResponse;
    } catch (err) {
      if (!(err instanceof ExecutorError)) throw err;
      lastErr = err;
      const reason = executorErrorReason(err);
      // Try the legacy `slack` namespace only when the reserved channel connector
      // is absent/not yet materialized. Do not fall back on `needs_auth` or
      // upstream Slack errors — those are real results from the right connector.
      if (
        connector === SLACK_CONNECTORS[0] &&
        (reason === 'connector_not_found' || reason === 'action_not_found')
      ) {
        continue;
      }
      throw new CliError(err.message);
    }
  }
  try {
    throw lastErr ?? new CliError(`Slack connector action "${action}" was not found`);
  } catch (err) {
    if (err instanceof ExecutorError) throw new CliError(err.message);
    throw err;
  }
}

function executorErrorReason(err: ExecutorError): string | null {
  const body = err.body;
  if (body && typeof body === 'object') {
    const reason = (body as { reason?: unknown }).reason;
    if (typeof reason === 'string') return reason;
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string') return error;
  }
  return err.message || null;
}

async function apiPost(
  method: string,
  body: Record<string, unknown>,
): Promise<SlackWebApiResponse> {
  return executorCall(method, body);
}

async function apiGet(
  method: string,
  params: Record<string, string>,
): Promise<SlackWebApiResponse> {
  return executorCall(method, params);
}

async function send(opts: {
  channel: string;
  text?: string;
  threadTs?: string;
  file?: string;
  blocks?: unknown[];
}) {
  if (opts.file) {
    if (!existsSync(opts.file)) throw new CliError(`File not found: ${opts.file}`);
    const fileData = readFileSync(opts.file);
    const fileName = opts.file.split('/').pop() || 'file';
    // Upload via the server-side proxy — the bot token stays on the server (the
    // 3-step external-upload + form-encoding can't ride the JSON Executor gateway).
    const projectId = kortixProjectId();
    if (!projectId) throw new CliError('KORTIX_PROJECT_ID not set — cannot upload.');
    const res = await kortixPost<{ ok?: boolean; files?: unknown }>(
      `/projects/${projectId}/channels/slack/file/upload`,
      {
        channel: opts.channel,
        filename: fileName,
        content_base64: fileData.toString('base64'),
        ...(opts.text ? { comment: opts.text } : {}),
        ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      },
    );
    return { ok: true, files: res.files, channel: opts.channel };
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
  const data = await apiPost('reactions.add', {
    channel: opts.channel,
    timestamp: opts.ts,
    name: opts.emoji,
  });
  if (!data.ok) throw new CliError(data.error ?? 'react failed');
  return { ok: true };
}

async function history(opts: { channel: string; limit?: number }) {
  const data = await apiGet('conversations.history', {
    channel: opts.channel,
    limit: String(opts.limit ?? 20),
  });
  if (!data.ok) throw new CliError(data.error ?? 'history failed');
  return { ok: true, messages: data.messages };
}

async function thread(opts: { channel: string; ts: string; limit?: number }) {
  const data = await apiGet('conversations.replies', {
    channel: opts.channel,
    ts: opts.ts,
    limit: String(opts.limit ?? 20),
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
  // Fetch via the server-side proxy — the bot token stays on the server. Binary,
  // so a raw fetch (not the JSON kortix client), authed with the session token.
  const apiUrl = getEnv('KORTIX_API_URL');
  const tok = getEnv('KORTIX_CLI_TOKEN') ?? getEnv('KORTIX_TOKEN');
  const projectId = kortixProjectId();
  if (!apiUrl || !tok || !projectId) {
    throw new CliError(
      'KORTIX_API_URL / KORTIX_CLI_TOKEN / KORTIX_PROJECT_ID not set — cannot download.',
    );
  }
  const proxyUrl = new URL(
    `/v1/projects/${projectId}/channels/slack/file?url=${encodeURIComponent(opts.url)}`,
    apiUrl,
  ).href;
  const res = await fetch(proxyUrl, {
    headers: { Authorization: `Bearer ${tok}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    let msg = `Download failed: HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* keep */
    }
    throw new CliError(msg);
  }
  const buf = await res.arrayBuffer();
  const dir = opts.out.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(opts.out, Buffer.from(buf));
  return { ok: true, path: opts.out, size: buf.byteLength };
}

// The manifest is built by apps/api (the SINGLE source of truth) and served at
// GET /v1/webhooks/slack/<projectId>/manifest. We just fetch + present it, so
// there's one manifest implementation no matter where you ask for it.
async function manifest(opts: { url?: string; projectId?: string; name?: string }) {
  const projectId = opts.projectId || kortixProjectId();
  if (!projectId) throw new CliError('--project-id required (or set KORTIX_PROJECT_ID)');

  const params: Record<string, string> = {};
  if (opts.name) params.name = opts.name;
  const m = await kortixGet<unknown>(`/webhooks/slack/${projectId}/manifest`, params);

  const publicUrl = (opts.url || getEnv('KORTIX_API_URL') || '').replace(/\/$/, '');
  const webhookUrl = publicUrl ? `${publicUrl}/v1/webhooks/slack/${projectId}` : undefined;
  return { ok: true, manifest: m, webhook_url: webhookUrl };
}

function readTextFlag(flags: Record<string, string>): string | undefined {
  if (flags['text-file']) {
    try {
      return readFileSync(flags['text-file'], 'utf-8');
    } catch {
      throw new CliError(`Cannot read --text-file: ${flags['text-file']}`);
    }
  }
  return flags.text;
}

function readBlocksFlag(flags: Record<string, string>): unknown[] | undefined {
  let raw: string | undefined;
  if (flags['blocks-file']) {
    try {
      raw = readFileSync(flags['blocks-file'], 'utf-8');
    } catch {
      throw new CliError(`Cannot read --blocks-file: ${flags['blocks-file']}`);
    }
  } else if (flags.blocks) {
    raw = flags.blocks === '-' ? readFileSync(0, 'utf-8') : flags.blocks;
  }
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`--blocks is not valid JSON: ${(err as Error).message}`);
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { blocks?: unknown }).blocks)
      ? (parsed as { blocks: unknown[] }).blocks
      : null;
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
      const { channel } = requiredFlags(flags, 'channel');
      out(
        await send({
          channel,
          text,
          blocks,
          threadTs: flags.thread,
          file: flags.file,
        }),
      );
      break;
    }
    case 'edit': {
      const { channel, ts } = requiredFlags(flags, 'channel', 'ts');
      const text = readTextFlag(flags);
      const blocks = readBlocksFlag(flags);
      if (!text && !blocks) throw new CliError('--text, --text-file, or --blocks required');
      out(await edit({ channel, ts, text, blocks }));
      break;
    }
    case 'delete':
      out(await del(requiredFlags(flags, 'channel', 'ts')));
      break;
    case 'react':
      out(await react(requiredFlags(flags, 'channel', 'ts', 'emoji')));
      break;
    case 'typing':
      validateRequired(flags, 'channel');
      out({ ok: true, note: 'Slack Web API does not support typing indicators for bots' });
      break;
    case 'history':
      out(await history({ ...requiredFlags(flags, 'channel'), limit: optionalInt(flags.limit) }));
      break;
    case 'thread':
      out(
        await thread({ ...requiredFlags(flags, 'channel', 'ts'), limit: optionalInt(flags.limit) }),
      );
      break;
    case 'channels':
      out(await listChannels({ limit: optionalInt(flags.limit) }));
      break;
    case 'channel-info':
      out(await channelInfo(requiredFlags(flags, 'channel')));
      break;
    case 'join':
      out(await join(requiredFlags(flags, 'channel')));
      break;
    case 'users':
      out(await listUsers({ limit: optionalInt(flags.limit) }));
      break;
    case 'user':
      out(await user(requiredFlags(flags, 'id')));
      break;
    case 'me':
      out(await me());
      break;
    case 'search':
      out(await search(requiredFlags(flags, 'query')));
      break;
    case 'file-info':
      out(await fileInfo({ fileId: requiredFlags(flags, 'file').file }));
      break;
    case 'download':
      out(await download(requiredFlags(flags, 'url', 'out')));
      break;
    case 'manifest':
      out(await manifest({ url: flags.url, projectId: flags['project-id'], name: flags.name }));
      break;
    case 'ask':
      // `slack ask` was replaced by opencode's native `question` tool. Calling
      // opencode's `question` from any agent turn triggered from Slack
      // surfaces the form in the same thread automatically via the
      // sandbox-side event subscriber. The CLI keeps this case so older
      // workflows fail loud instead of pretending to work.
      throw new CliError(
        "`slack ask` was removed — use opencode's built-in `question` tool. " +
          "The Slack form is rendered automatically by the sandbox's opencode-events subscriber.",
      );
    default:
      console.log(`
slack — Slack Web API adapter

Auth: none in-sandbox — calls run through the Kortix Executor (server-side bot token).

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
