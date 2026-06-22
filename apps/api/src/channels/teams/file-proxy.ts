import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { teamsPendingUploads } from '@kortix/db';
import { db } from '../../shared/db';
import { graphToken } from '../teams-auth';
import { loadTeamsTenantForProject } from '../install-store';
import { sendActivity } from '../teams-api';
import type { TeamsActivity, TeamsConversationRef } from './types';

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;

const ALLOWED_DOWNLOAD_HOST = /(^|\.)(sharepoint\.com|sharepoint-df\.com|svc\.ms|microsoft\.com|office\.com)$/i;

export type FileProxyError = { ok: false; error: string; status: number };

export async function downloadTeamsFile(
  projectId: string,
  url: string,
): Promise<{ ok: true; body: ArrayBuffer; contentType: string } | FileProxyError> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid url', status: 400 };
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOST.test(parsed.hostname)) {
    return { ok: false, error: 'url must be an https Microsoft/SharePoint file URL', status: 400 };
  }

  const headers: Record<string, string> = {};
  if (/(^|\.)graph\.microsoft\.com$/i.test(parsed.hostname)) {
    const tenant = await loadTeamsTenantForProject(projectId);
    if (!tenant) return { ok: false, error: 'Teams not connected for this project', status: 404 };
    const token = await graphToken(tenant).catch(() => null);
    if (!token) return { ok: false, error: 'could not mint a Graph token', status: 502 };
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(parsed.href, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return { ok: false, error: `download failed: HTTP ${res.status}`, status: 502 };
  return {
    ok: true,
    body: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export interface TeamsUploadArgs {
  serviceUrl: string;
  conversationId: string;
  botId?: string;
  filename: string;
  contentBase64: string;
  description?: string;
}

export async function initiateTeamsUpload(
  projectId: string,
  args: TeamsUploadArgs,
): Promise<{ ok: true; uploadId: string } | FileProxyError> {
  if (!args.serviceUrl || !args.conversationId || !args.filename || !args.contentBase64) {
    return { ok: false, error: 'serviceUrl, conversationId, filename and content_base64 are required', status: 400 };
  }
  const size = Buffer.byteLength(args.contentBase64, 'base64');
  if (size <= 0) return { ok: false, error: 'empty file', status: 400 };
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `file exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`, status: 400 };
  }

  await db.delete(teamsPendingUploads).where(lt(teamsPendingUploads.expiresAt, new Date())).catch(() => {});

  const uploadId = randomUUID();
  await db.insert(teamsPendingUploads).values({
    uploadId,
    projectId,
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    botId: args.botId ?? null,
    filename: args.filename,
    contentType: null,
    contentBase64: args.contentBase64,
    size,
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
  });

  const ref: TeamsConversationRef = { serviceUrl: args.serviceUrl, conversationId: args.conversationId, botId: args.botId };
  const posted = await sendActivity(ref, {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.teams.card.file.consent',
        content: {
          description: args.description ?? `Kortix wants to send you ${args.filename}.`,
          sizeInBytes: size,
            acceptContext: { uploadId },
          declineContext: { uploadId },
        },
        name: args.filename,
      },
    ],
  });
  if (!posted) {
    await db.delete(teamsPendingUploads).where(eq(teamsPendingUploads.uploadId, uploadId)).catch(() => {});
    return { ok: false, error: 'failed to post the file consent card', status: 502 };
  }
  return { ok: true, uploadId };
}

interface FileConsentValue {
  action?: 'accept' | 'decline';
  context?: { uploadId?: string };
  uploadInfo?: { uploadUrl?: string; contentUrl?: string; name?: string; uniqueId?: string; fileType?: string };
}

export async function handleFileConsentInvoke(activity: TeamsActivity): Promise<void> {
  const value = (activity as unknown as { value?: FileConsentValue }).value ?? {};
  const uploadId = value.context?.uploadId;
  if (!uploadId) return;

  const [row] = await db
    .select()
    .from(teamsPendingUploads)
    .where(eq(teamsPendingUploads.uploadId, uploadId))
    .limit(1);

  const ref: TeamsConversationRef = {
    serviceUrl: activity.serviceUrl ?? row?.serviceUrl ?? '',
    conversationId: activity.conversation?.id ?? row?.conversationId ?? '',
    botId: activity.recipient?.id ?? row?.botId ?? undefined,
  };

  if (value.action !== 'accept') {
    await db.delete(teamsPendingUploads).where(eq(teamsPendingUploads.uploadId, uploadId)).catch(() => {});
    return;
  }
  if (!row || !value.uploadInfo?.uploadUrl) {
    if (ref.serviceUrl && ref.conversationId) {
      await sendActivity(ref, { type: 'message', text: 'That upload expired — ask me to send the file again.' });
    }
    await db.delete(teamsPendingUploads).where(eq(teamsPendingUploads.uploadId, uploadId)).catch(() => {});
    return;
  }

  const bytes = Buffer.from(row.contentBase64, 'base64');
  const put = await fetch(value.uploadInfo.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(bytes.length),
      'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
    },
    body: bytes,
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);

  await db.delete(teamsPendingUploads).where(eq(teamsPendingUploads.uploadId, uploadId)).catch(() => {});

  if (!put || !put.ok) {
    if (ref.serviceUrl && ref.conversationId) {
      await sendActivity(ref, { type: 'message', text: `Couldn’t upload ${row.filename}.` });
    }
    return;
  }

  await sendActivity(ref, {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.teams.card.file.info',
        contentUrl: value.uploadInfo.contentUrl,
        name: value.uploadInfo.name ?? row.filename,
        content: { uniqueId: value.uploadInfo.uniqueId, fileType: value.uploadInfo.fileType },
      },
    ],
  });
}
