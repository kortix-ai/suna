#!/usr/bin/env bun
// The published Kortix Executor SDK — baked into the sandbox at the mirrored
// path (/opt/kortix/packages/executor-sdk). The Recall.ai API key is resolved +
// attached SERVER-SIDE by the Executor gateway (as `Authorization: Token …`); it
// never reaches this sandbox. Mirrors the `slack` CLI's gateway posture.
import { ExecutorError, createExecutorClient } from '../../../../packages/executor-sdk/src/index';
import { CliError, getEnv, handleError, kortixPost, kortixProjectId, out, parseArgs } from '../lib';

// The reserved, platform-owned channel slug the Meet (Recall.ai) connector
// materializes under — must match MEET_CHANNEL_CONNECTOR_SLUG in apps/api.
const MEET_CONNECTOR = 'kortix_meet';

// Default recording config so `meet transcript` works out of the box: Recall's
// `meeting_captions` provider transcribes from the platform's own captions (the
// cheapest option, no external STT vendor). Override with --recording-config.
const DEFAULT_RECORDING_CONFIG = { transcript: { provider: { meeting_captions: {} } } };

// The Executor SDK client, built from this sandbox's env. Setting projectId
// makes the SDK use the project-explicit gateway route, which accepts the
// in-sandbox session token.
function executorClient() {
  const apiUrl = getEnv('KORTIX_API_URL');
  const token = getEnv('KORTIX_CLI_TOKEN') ?? getEnv('KORTIX_TOKEN');
  if (!apiUrl || !token) {
    throw new CliError('KORTIX_API_URL / KORTIX_CLI_TOKEN not set — cannot reach the Executor.');
  }
  return createExecutorClient({ apiUrl, token, projectId: kortixProjectId() });
}

// Route a Recall.ai action through the Kortix Executor (via the SDK). The Recall
// key is attached server-side; on an upstream error the SDK throws an
// ExecutorError, surfaced here as a clean CliError.
async function call(action: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const res = await executorClient().call(MEET_CONNECTOR, action, args);
    return (res.data ?? res) as unknown;
  } catch (err) {
    if (err instanceof ExecutorError) throw new CliError(executorErrorReason(err) ?? err.message);
    throw err;
  }
}

function executorErrorReason(err: ExecutorError): string | null {
  const body = err.body;
  if (body && typeof body === 'object') {
    for (const k of ['reason', 'error', 'message'] as const) {
      const v = (body as Record<string, unknown>)[k];
      if (typeof v === 'string') return v;
    }
  }
  return err.message || null;
}

// Recall returns the bot object; surface the id prominently since every other
// command keys off it.
export function botId(data: unknown): string | undefined {
  if (data && typeof data === 'object' && typeof (data as { id?: unknown }).id === 'string') {
    return (data as { id: string }).id;
  }
  return undefined;
}

async function join(opts: { url: string; botName?: string; recordingConfig?: unknown }) {
  const args: Record<string, unknown> = {
    meeting_url: opts.url,
    recording_config: opts.recordingConfig ?? DEFAULT_RECORDING_CONFIG,
  };
  if (opts.botName) args.bot_name = opts.botName;
  const data = await call('join_meeting', args);
  return { ok: true, bot_id: botId(data), bot: data };
}

async function leave(id: string) {
  const data = await call('leave_meeting', { id });
  return { ok: true, bot_id: id, result: data ?? 'leaving' };
}

async function status(id: string) {
  const data = await call('bot_status', { id });
  return { ok: true, ...(data && typeof data === 'object' ? data : { result: data }) };
}

async function chat(id: string, message: string) {
  const data = await call('send_chat_message', { id, message });
  return { ok: true, bot_id: id, sent: message, result: data ?? 'sent' };
}

// Speak aloud in the meeting (TTS voice). Server-side proxy: text → ElevenLabs
// (the project's chosen voice) → Recall output_audio. Keys stay on the server.
async function speak(id: string, text: string, voice?: string) {
  const projectId = kortixProjectId();
  if (!projectId) throw new CliError('KORTIX_PROJECT_ID not set — cannot speak.');
  const res = await kortixPost<Record<string, unknown>>(`/projects/${projectId}/channels/meet/speak`, {
    bot_id: id,
    text,
    ...(voice ? { voice } : {}),
  });
  return { ok: true, bot_id: id, spoke: text, ...(res && typeof res === 'object' ? res : {}) };
}

async function transcript(id: string) {
  // List the bot's transcript artifact(s) through the gateway, then follow the
  // presigned download_url (a plain GET — the URL is already signed) to the JSON.
  const data = (await call('get_transcript', { bot_id: id })) as {
    results?: Array<{ status?: { code?: string }; data?: { download_url?: string | null } }>;
  };
  const artifact = data?.results?.[0];
  const url = artifact?.data?.download_url ?? null;
  if (!url) {
    return {
      ok: true,
      bot_id: id,
      status: artifact?.status?.code ?? 'no_transcript',
      note: 'Transcript not ready yet (still processing or no speech captured). Try again shortly.',
    };
  }
  const segments = await (await fetch(url)).json();
  return { ok: true, bot_id: id, segments };
}

export function readRecordingConfig(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`--recording-config is not valid JSON: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);
  switch (command) {
    case 'join': {
      const url = args[0];
      if (!url) throw new CliError('meeting URL required, e.g. meet join https://meet.google.com/abc-defg-hij');
      out(await join({ url, botName: flags['bot-name'], recordingConfig: readRecordingConfig(flags['recording-config']) }));
      break;
    }
    case 'leave': {
      const id = args[0];
      if (!id) throw new CliError('bot id required, e.g. meet leave <bot_id>');
      out(await leave(id));
      break;
    }
    case 'status': {
      const id = args[0];
      if (!id) throw new CliError('bot id required, e.g. meet status <bot_id>');
      out(await status(id));
      break;
    }
    case 'chat': {
      const id = args[0];
      const message = (flags.text ?? args.slice(1).join(' ')).trim();
      if (!id) throw new CliError('bot id required, e.g. meet chat <bot_id> "message"');
      if (!message) throw new CliError('message required, e.g. meet chat <bot_id> "On it — sharing the doc."');
      out(await chat(id, message));
      break;
    }
    case 'speak': {
      const id = args[0];
      const text = (flags.text ?? args.slice(1).join(' ')).trim();
      if (!id) throw new CliError('bot id required, e.g. meet speak <bot_id> "message"');
      if (!text) throw new CliError('text required, e.g. meet speak <bot_id> "Sure, the Q3 numbers are up 12 percent."');
      out(await speak(id, text, flags.voice));
      break;
    }
    case 'transcript': {
      const id = args[0];
      if (!id) throw new CliError('bot id required, e.g. meet transcript <bot_id>');
      out(await transcript(id));
      break;
    }
    default:
      console.log(`
meet — meeting notetaker for Google Meet / Zoom / Microsoft Teams (via Recall.ai)

Auth: none in-sandbox — calls run through the Kortix Executor (server-side Recall key).

Commands:
  join       <meeting-url> ([--bot-name], [--recording-config '<json>'])  # send the bot; returns a bot id
  leave      <bot-id>                                                     # remove the bot (irreversible)
  status     <bot-id>                                                     # bot status + recordings
  transcript <bot-id>                                                     # speaker-labelled transcript so far
  chat       <bot-id> "<message>"                                         # post to the meeting chat (the bot talks back)
  speak      <bot-id> "<message>" ([--voice <id>])                        # SAY it aloud in the call (TTS voice)

<meeting-url> is the full meeting link — Google Meet, Zoom, or Microsoft Teams; the
platform is detected from the URL. join returns a bot id that the other commands take.
Transcripts use the platform's own captions; speak uses the project's selected voice.
`);
      break;
  }
}

if (import.meta.main) {
  main().catch(handleError);
}
