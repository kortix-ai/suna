#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import {
  parseArgs,
  out,
  CliError,
  handleError,
  getEnv,
  kortixProjectId,
  kortixSessionId,
  kortixPost,
} from '../lib';
import { createExecutorClient, ExecutorError } from '../../../../packages/executor-sdk/src/index';

const TEAMS_CONNECTOR = 'teams';

function executorClient() {
  const apiUrl = getEnv('KORTIX_API_URL');
  const token = getEnv('KORTIX_CLI_TOKEN') ?? getEnv('KORTIX_TOKEN');
  if (!apiUrl || !token) {
    throw new CliError('KORTIX_API_URL / KORTIX_CLI_TOKEN not set — cannot reach the Executor.');
  }
  return createExecutorClient({ apiUrl, token, projectId: kortixProjectId() });
}

async function executorCall(action: string, args: Record<string, unknown>): Promise<any> {
  try {
    const res = await executorClient().call(TEAMS_CONNECTOR, action, args);
    return res.data ?? res;
  } catch (err) {
    if (err instanceof ExecutorError) throw new CliError(err.message);
    throw err;
  }
}

async function relayTurnStream(
  kind: 'step' | 'answer',
  text: string,
  extras: { detail?: string; output?: string; sources?: Array<{ url: string; text: string }> } = {},
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
      const text = readTextFlag(flags) ?? args[0];
      if (!text) throw new CliError('message text required, e.g. teams send "Done — here is the summary"');
      const relayed = await relayTurnStream('answer', text.slice(0, 11000));
      if (relayed) {
        out({ ok: true, delivered: 'stream' });
        break;
      }
      throw new CliError('No active Teams turn to answer.');
    }
    case 'team':
      if (!flags.team) throw new CliError('--team <team-id> required');
      out(await executorCall('get_team', { 'team-id': flags.team }));
      break;
    case 'channels':
      if (!flags.team) throw new CliError('--team <team-id> required');
      out(await executorCall('list_channels', { 'team-id': flags.team }));
      break;
    case 'channel':
      if (!flags.team || !flags.channel) throw new CliError('--team and --channel required');
      out(await executorCall('get_channel', { 'team-id': flags.team, 'channel-id': flags.channel }));
      break;
    case 'members':
      if (!flags.team) throw new CliError('--team <team-id> required');
      out(await executorCall('list_members', { 'team-id': flags.team }));
      break;
    case 'user':
      if (!flags.id) throw new CliError('--id <user-id> required');
      out(await executorCall('get_user', { 'user-id': flags.id }));
      break;
    case 'help':
    default:
      console.log(`
teams — Microsoft Teams adapter

Auth: none in-sandbox — turn replies are rendered by the Kortix server; vendor
reads run through the Kortix Executor (Graph token resolved server-side).

Turn commands (use these when answering a Teams message):
  step  "<checkpoint>"   [--detail "<subtitle>"] [--output "<prev result>"] [--source URL|TITLE]
  send  "<answer>"       # deliver your reply — finalizes the live Adaptive Card

Read commands (Microsoft Graph, via the Executor):
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
