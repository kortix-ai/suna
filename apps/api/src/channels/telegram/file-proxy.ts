/**
 * Server-side Telegram file proxy — the binary/multipart ops the Executor
 * gateway (JSON in/out) can't carry, done with the bot token SERVER-SIDE so
 * the sandbox never holds it. Backs the in-sandbox `telegram download` and
 * `telegram send --file`.
 *
 * Unlike Slack's proxy (caller-supplied URL → host allow-list), the download
 * URL here is CONSTRUCTED by us: file_id → getFile → file_path →
 * {api base}/file/bot{token}/{file_path}. The only caller-influenced part is
 * the file_path Telegram returns, so `safeTelegramFilePath` rejects anything
 * that could escape the path segment (schemes, '..', absolute paths, '?', '#').
 */
import { loadTelegramTokenForProject } from '../install-store';
import { redactToken, telegramApiBase, telegramApiCall } from '../telegram-api';

/** Telegram's Bot API serves files up to 20 MB; cap with margin. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Bot API upload limit is 50 MB. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type TelegramFileProxyError = { ok: false; error: string; status: number };

/** A file_path from getFile must be a plain relative path — nothing that can
 *  break out of `${base}/file/bot${token}/…`. Exported for tests. */
export function safeTelegramFilePath(filePath: string): boolean {
  if (!filePath || filePath.length > 512) return false;
  if (filePath.startsWith('/') || filePath.includes('..')) return false;
  if (/[?#\\]/.test(filePath)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(filePath)) return false; // no scheme
  return /^[A-Za-z0-9_\-./ ()]+$/.test(filePath);
}

/** Resolve a file_id and fetch its bytes, token server-side, size-capped. */
export async function downloadTelegramFile(
  projectId: string,
  fileId: string,
): Promise<{ ok: true; body: ArrayBuffer; contentType: string; fileName: string | null } | TelegramFileProxyError> {
  if (!fileId || fileId.length > 256) return { ok: false, error: 'invalid file_id', status: 400 };
  const token = await loadTelegramTokenForProject(projectId);
  if (!token) return { ok: false, error: 'Telegram not connected for this project', status: 404 };

  const info = await telegramApiCall<{ file_path?: string; file_size?: number }>(
    token,
    'getFile',
    { file_id: fileId },
    { retries: 1 },
  );
  if (!info.ok || !info.result?.file_path) {
    return { ok: false, error: `getFile failed: ${info.description ?? 'unknown'}`, status: 502 };
  }
  const filePath = info.result.file_path;
  if (!safeTelegramFilePath(filePath)) {
    return { ok: false, error: 'unexpected file_path from Telegram', status: 502 };
  }
  if ((info.result.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: 'file exceeds the 25MB download cap', status: 400 };
  }

  let res: Response;
  try {
    res = await fetch(`${telegramApiBase()}/file/bot${token}/${filePath}`, {
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return { ok: false, error: redactToken((err as Error)?.message ?? 'download failed'), status: 502 };
  }
  if (!res.ok) return { ok: false, error: `download failed: HTTP ${res.status}`, status: 502 };
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: 'file exceeds the 25MB download cap', status: 400 };
  }
  return {
    ok: true,
    body,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    fileName: filePath.split('/').pop() ?? null,
  };
}

/** Send a sandbox file into a chat — multipart sendDocument, token server-side. */
export async function uploadTelegramFile(
  projectId: string,
  args: {
    chatId: string;
    filename: string;
    contentBase64: string;
    caption?: string;
    replyToMessageId?: number;
  },
): Promise<{ ok: true; messageId: number | null } | TelegramFileProxyError> {
  if (!args.chatId || !args.filename || !args.contentBase64) {
    return { ok: false, error: 'chat_id, filename and content_base64 are required', status: 400 };
  }
  const token = await loadTelegramTokenForProject(projectId);
  if (!token) return { ok: false, error: 'Telegram not connected for this project', status: 404 };

  const bytes = Buffer.from(args.contentBase64, 'base64');
  if (bytes.length === 0) return { ok: false, error: 'empty file content', status: 400 };
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'file exceeds the 50MB upload cap', status: 400 };
  }

  const form = new FormData();
  form.set('chat_id', args.chatId);
  form.set('document', new Blob([bytes]), args.filename.replace(/[/\\]/g, '_'));
  if (args.caption) form.set('caption', args.caption.slice(0, 1024));
  if (args.replyToMessageId) {
    form.set(
      'reply_parameters',
      JSON.stringify({ message_id: args.replyToMessageId, allow_sending_without_reply: true }),
    );
  }

  let res: Response;
  try {
    res = await fetch(`${telegramApiBase()}/bot${token}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    return { ok: false, error: redactToken((err as Error)?.message ?? 'upload failed'), status: 502 };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; description?: string; result?: { message_id?: number } }
    | null;
  if (!data?.ok) {
    return {
      ok: false,
      error: `sendDocument failed: ${redactToken(data?.description ?? `HTTP ${res.status}`)}`,
      status: 502,
    };
  }
  return { ok: true, messageId: data.result?.message_id ?? null };
}
