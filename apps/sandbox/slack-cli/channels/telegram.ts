#!/usr/bin/env bun
/**
 * telegram — the in-sandbox CLI for Telegram-originated sessions.
 *
 * NO TOKEN in the sandbox: `step`/`send` relay through the Kortix API
 * (/projects/:id/turn-stream), which owns the live status message and holds
 * the bot token server-side; `download`/`send --file` go through the
 * server-side file proxy the same way. Richer calls (get_chat, send_document
 * by file_id/URL) use the executor gateway's `kortix_telegram` connector.
 *
 *   telegram step "Reading the logs"                 → advance the live checklist
 *   telegram send "All done — summary…"              → final answer (markdown ok)
 *   telegram send --file report.pdf --caption "…"    → send a workspace file
 *   telegram download --file-id <id> --out in.pdf    → pull a received file
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CliError,
  getEnv,
  handleError,
  kortixPost,
  kortixProjectId,
  kortixSessionId,
  out,
  parseArgs,
} from '../lib';

async function relayTurnStream(kind: 'step' | 'answer', text: string): Promise<boolean> {
  const projectId = kortixProjectId();
  const sessionId = kortixSessionId();
  if (!projectId || !sessionId) return false;
  try {
    const r = await kortixPost<{ ok?: boolean }>(`/projects/${projectId}/turn-stream`, {
      session_id: sessionId,
      kind,
      text,
    });
    return r?.ok === true;
  } catch {
    return false;
  }
}

// ─── File proxy (binary — raw fetch with the session token, like `slack download`) ───

function proxyContext(): { apiUrl: string; token: string; projectId: string } {
  const apiUrl = getEnv('KORTIX_API_URL');
  const token = getEnv('KORTIX_CLI_TOKEN') ?? getEnv('KORTIX_TOKEN');
  const projectId = kortixProjectId();
  if (!apiUrl || !token || !projectId) {
    throw new CliError('KORTIX_API_URL / KORTIX_CLI_TOKEN / KORTIX_PROJECT_ID not set.');
  }
  return { apiUrl, token, projectId };
}

async function download(opts: { fileId: string; outPath: string }) {
  const { apiUrl, token, projectId } = proxyContext();
  const url = new URL(
    `/v1/projects/${projectId}/channels/telegram/file?file_id=${encodeURIComponent(opts.fileId)}`,
    apiUrl,
  ).href;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90_000),
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
  const dir = opts.outPath.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(opts.outPath, Buffer.from(buf));
  return { ok: true, path: opts.outPath, size: buf.byteLength };
}

async function sendFile(opts: { path: string; caption?: string }) {
  if (!existsSync(opts.path)) throw new CliError(`No such file: ${opts.path}`);
  const { projectId } = proxyContext();
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!chatId) throw new CliError('TELEGRAM_CHAT_ID not set — is this a Telegram session?');
  const bytes = readFileSync(opts.path);
  const r = await kortixPost<{ ok?: boolean; message_id?: number; error?: string }>(
    `/projects/${projectId}/channels/telegram/file/upload`,
    {
      chat_id: chatId,
      filename: opts.path.split('/').pop(),
      content_base64: bytes.toString('base64'),
      ...(opts.caption ? { caption: opts.caption } : {}),
    },
  );
  if (r?.ok !== true) throw new CliError(r?.error ?? 'upload failed');
  return { ok: true, message_id: r.message_id ?? null };
}

const HELP = `telegram — talk back to the Telegram chat that started this session.

Usage:
  telegram step "Short progress checkpoint"        Update the live status message.
  telegram send "Final answer"                     Deliver the answer (markdown ok:
                                                   **bold**, *italic*, \`code\`,
                                                   fenced blocks, [links](https://…)).
  telegram send --file <path> [--caption "…"]      Send a workspace file to the chat.
  telegram download --file-id <id> --out <path>    Pull a received file into the workspace.
  telegram help                                    This help.

No token needed — everything relays through Kortix; the bot token stays
server-side. One text \`telegram send\` per turn: it finalizes the live message.
For chat metadata use the executor connector actions (kortix_telegram:
get_chat, get_file, send_document by file_id/URL).`;

async function main() {
  const { command, args, flags } = parseArgs(process.argv);
  const text = args.join(' ').trim();

  switch (command) {
    case 'step': {
      if (!text) return out({ ok: false, error: 'usage: telegram step "progress text"' });
      return out({ ok: await relayTurnStream('step', text) });
    }
    case 'send': {
      if (flags.file) {
        return out(await sendFile({ path: flags.file, caption: flags.caption || text || undefined }));
      }
      if (!text) return out({ ok: false, error: 'usage: telegram send "final answer" | telegram send --file <path>' });
      return out({ ok: await relayTurnStream('answer', text) });
    }
    case 'download': {
      if (!flags['file-id']) {
        return out({ ok: false, error: 'usage: telegram download --file-id <id> --out <path>' });
      }
      const outPath = flags.out || `./telegram-file-${flags['file-id'].slice(0, 8)}`;
      return out(await download({ fileId: flags['file-id'], outPath }));
    }
    default: {
      console.log(HELP);
    }
  }
}

main().catch(handleError);
