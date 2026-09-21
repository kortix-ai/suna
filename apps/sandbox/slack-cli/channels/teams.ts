#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CliError,
  getEnv,
  handleError,
  kortixConnectorCall,
  kortixPost,
  kortixProjectId,
  kortixSessionId,
  out,
  parseArgs,
} from '../lib';

// The Teams channel materializes under the reserved slug `kortix_teams`
// (apps/api/src/connectors/channels.ts TEAMS_CHANNEL_CONNECTOR_SLUG). The bare
// `teams` name is kept as a fallback for a user-declared connector of that
// name and for older API deployments — same shape as the Slack CLI.
const TEAMS_CONNECTORS = ['kortix_teams', 'teams'] as const;

function resolveDownloadOutput(outPath: string): string {
  const trimmed = outPath.trim();
  if (!trimmed) throw new CliError('--out must be a file path');
  if (trimmed.endsWith('/') || trimmed.endsWith('\\'))
    throw new CliError('--out must point to a file, not a directory');
  return resolve(trimmed);
}

async function downloadFile(url: string, outPath: string) {
  const apiUrl = getEnv('KORTIX_API_URL');
  const tok = getEnv('KORTIX_TOKEN');
  const projectId = kortixProjectId();
  if (!apiUrl || !tok || !projectId) {
    throw new CliError(
      'KORTIX_API_URL / KORTIX_TOKEN / KORTIX_PROJECT_ID not set — cannot download.',
    );
  }
  const proxyUrl = new URL(
    `/v1/projects/${projectId}/channels/teams/file?url=${encodeURIComponent(url)}`,
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
  const resolvedOut = resolveDownloadOutput(outPath);
  mkdirSync(dirname(resolvedOut), { recursive: true });
  await Bun.write(resolvedOut, Buffer.from(buf));
  chmodSync(resolvedOut, 0o600);
  return { ok: true, path: resolvedOut, size: buf.byteLength };
}

async function sendFile(filePath: string, description?: string) {
  if (!existsSync(filePath)) throw new CliError(`File not found: ${filePath}`);
  const projectId = kortixProjectId();
  const serviceUrl = getEnv('MS_TEAMS_SERVICE_URL');
  const conversationId = getEnv('MS_TEAMS_CONVERSATION_ID');
  if (!projectId) throw new CliError('KORTIX_PROJECT_ID not set — cannot upload.');
  if (!serviceUrl || !conversationId) {
    throw new CliError(
      'MS_TEAMS_SERVICE_URL / MS_TEAMS_CONVERSATION_ID not set — no active Teams conversation.',
    );
  }
  const data = readFileSync(filePath);
  const filename = filePath.split('/').pop() || 'file';
  // Personal chats take a consent card; channels/group chats get an inline
  // image or a team-drive link. The server decides from the scope + team.
  const conversationType = getEnv('MS_TEAMS_CONVERSATION_TYPE');
  const teamGroupId = getEnv('MS_TEAMS_TEAM_GROUP_ID');
  const r = await kortixPost<{ ok?: boolean; delivered?: string; uploadId?: string; url?: string }>(
    `/projects/${projectId}/channels/teams/file/upload`,
    {
      service_url: serviceUrl,
      conversation_id: conversationId,
      filename,
      content_base64: data.toString('base64'),
      ...(description ? { description } : {}),
      ...(conversationType ? { conversation_type: conversationType } : {}),
      ...(teamGroupId ? { team_group_id: teamGroupId } : {}),
    },
  );
  return {
    ok: true,
    delivered: r?.delivered ?? 'consent_card',
    ...(r?.uploadId ? { uploadId: r.uploadId } : {}),
    ...(r?.url ? { url: r.url } : {}),
  };
}

async function connectorCall(action: string, args: Record<string, unknown>): Promise<unknown> {
  let lastErr: CliError | null = null;
  for (const connector of TEAMS_CONNECTORS) {
    try {
      const res = await kortixConnectorCall<{ data?: unknown }>(`${connector}.${action}`, args);
      return (res as { data?: unknown }).data ?? res;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      lastErr = err;
      const reason = err.message || null;
      // Fall back to the legacy namespace only when the reserved connector is
      // absent; an upstream Graph error is a real answer from the right one.
      if (connector === TEAMS_CONNECTORS[0] && (reason === 'connector_not_found' || reason === 'action_not_found')) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new CliError(`Teams connector action "${action}" was not found`);
}

async function relayTurnStream(
  kind: 'step' | 'answer',
  text: string,
  extras: {
    detail?: string;
    output?: string;
    sources?: Array<{ url: string; text: string }>;
    card?: Record<string, unknown>;
    form?: Record<string, unknown>;
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
      ...(extras.card ? { card: extras.card } : {}),
      ...(extras.form ? { form: extras.form } : {}),
    });
    return r?.ok === true;
  } catch {
    return false;
  }
}

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

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);
  switch (command) {
    case 'step': {
      const text = (readTextFlag(flags) ?? args[0] ?? '').trim();
      if (!text) throw new CliError('checkpoint text required, e.g. teams step "Reading the logs"');
      const detail = flags.detail?.trim() || undefined;
      const output = flags.output?.trim() || undefined;
      const sources = readSourcesFlag(flags);
      const relayed = await relayTurnStream('step', text, { detail, output, sources });
      out({ ok: true, relayed });
      break;
    }
    case 'send': {
      if (flags.file) {
        out(await sendFile(flags.file, readTextFlag(flags) ?? args[0]));
        break;
      }
      let card: Record<string, unknown> | undefined;
      if (flags['card-file']) {
        try {
          card = JSON.parse(readFileSync(flags['card-file'], 'utf-8')) as Record<string, unknown>;
        } catch {
          throw new CliError(`Cannot read/parse --card-file: ${flags['card-file']}`);
        }
        if (card.type !== 'AdaptiveCard') {
          throw new CliError('--card-file must be an Adaptive Card JSON object (type: "AdaptiveCard")');
        }
      }
      const text = readTextFlag(flags) ?? args[0];
      if (!text && !card)
        throw new CliError('message text required, e.g. teams send "Done — here is the summary"');
      const relayed = await relayTurnStream('answer', (text ?? 'Done.').slice(0, 11000), { card });
      if (relayed) {
        out({ ok: true, delivered: card ? 'card' : 'stream' });
        break;
      }
      throw new CliError('No active Teams turn to answer.');
    }
    case 'ask': {
      if (!flags['form-file']) throw new CliError('--form-file <path> required');
      let form: Record<string, unknown>;
      try {
        form = JSON.parse(readFileSync(flags['form-file'], 'utf-8')) as Record<string, unknown>;
      } catch {
        throw new CliError(`Cannot read/parse --form-file: ${flags['form-file']}`);
      }
      if (!Array.isArray((form as { fields?: unknown }).fields)) {
        throw new CliError('--form-file must be a JSON object with a "fields" array');
      }
      const text = readTextFlag(flags) ?? args[0] ?? 'A few details, please.';
      const relayed = await relayTurnStream('answer', text, { form });
      if (relayed) {
        out({ ok: true, delivered: 'form' });
        break;
      }
      throw new CliError('No active Teams turn to post a form into.');
    }
    case 'conversations': {
      const projectId = kortixProjectId();
      if (!projectId) throw new CliError('KORTIX_PROJECT_ID not set.');
      const apiUrl = getEnv('KORTIX_API_URL');
      const tok = getEnv('KORTIX_TOKEN');
      if (!apiUrl || !tok) throw new CliError('KORTIX_API_URL / KORTIX_TOKEN not set.');
      const res = await fetch(
        new URL(`/v1/projects/${projectId}/channels/teams/conversations`, apiUrl).href,
        { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(30_000) },
      );
      if (!res.ok) throw new CliError(`Could not list conversations: HTTP ${res.status}`);
      out(await res.json());
      break;
    }
    case 'post': {
      const projectId = kortixProjectId();
      if (!projectId) throw new CliError('KORTIX_PROJECT_ID not set.');
      const conversationId = flags.conversation ?? flags.to;
      if (!conversationId) throw new CliError('--conversation <id> required (see `teams conversations`)');
      let card: Record<string, unknown> | undefined;
      if (flags['card-file']) {
        try {
          card = JSON.parse(readFileSync(flags['card-file'], 'utf-8')) as Record<string, unknown>;
        } catch {
          throw new CliError(`Cannot read/parse --card-file: ${flags['card-file']}`);
        }
      }
      const text = readTextFlag(flags) ?? args[0];
      if (!text && !card) throw new CliError('message text or --card-file required');
      out(
        await kortixPost(`/projects/${projectId}/channels/teams/message`, {
          conversation_id: conversationId,
          ...(text ? { text } : {}),
          ...(card ? { card } : {}),
        }),
      );
      break;
    }
    case 'download':
      if (!flags.url || !flags.out) throw new CliError('--url and --out required');
      out(await downloadFile(flags.url, flags.out));
      break;
    case 'team':
      if (!flags.team) throw new CliError('--team <team-id> required');
      out(await connectorCall('get_team', { 'team-id': flags.team }));
      break;
    case 'channels':
      if (!flags.team) throw new CliError('--team <team-id> required');
      out(await connectorCall('list_channels', { 'team-id': flags.team }));
      break;
    case 'channel':
      if (!flags.team || !flags.channel) throw new CliError('--team and --channel required');
      out(
        await connectorCall('get_channel', { 'team-id': flags.team, 'channel-id': flags.channel }),
      );
      break;
    case 'members':
      if (!flags.team) throw new CliError('--team <team-id> required');
      out(await connectorCall('list_members', { 'team-id': flags.team }));
      break;
    case 'user':
      if (!flags.id) throw new CliError('--id <user-id> required');
      out(await connectorCall('get_user', { 'user-id': flags.id }));
      break;
    default:
      console.log(`
teams — Microsoft Teams adapter

Auth: none in-sandbox — turn replies are rendered by the Kortix server; vendor
reads run through the Kortix Connector (Graph token resolved server-side).

Turn commands (use these when answering a Teams message):
  step  "<checkpoint>"   [--detail "<subtitle>"] [--output "<prev result>"] [--source URL|TITLE]
  send  "<answer>"       # deliver your reply — finalizes the live Adaptive Card
  send  --card-file <path>   # deliver a full Adaptive Card JSON as the reply
  ask   --form-file <path>   # post a FORM — real text boxes, dropdowns, toggles, one Submit
                             # {"title":"...","fields":[{"id":"env","label":"Environment",
                             #   "type":"choice","choices":["prod","staging"],"required":true}]}
                             # types: text | textarea | number | date | time | choice | multichoice | toggle
                             # The answers come back as your NEXT turn — post it, then END your turn.

Posting somewhere else (proactive — NOT this turn's reply):
  conversations                                     # chats/channels this project may post into
  post --conversation <id> "<text>"                 # post there now
  post --conversation <id> --card-file <path>       # ...as an Adaptive Card

Files:
  send     --file <path> [--text "<description>"]   # personal chat: consent card; channel: inline image or team-drive link
  download --url <url> --out <path>                 # download a file shared in the conversation

Read commands (Microsoft Graph, via the Connector):
  team      --team <team-id>
  channels  --team <team-id>
  channel   --team <team-id> --channel <channel-id>
  members   --team <team-id>
  user      --id <user-id>
`);
      break;
  }
}

if (import.meta.main) {
  main().catch(handleError);
}
