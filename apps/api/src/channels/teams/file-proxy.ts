import { randomUUID } from 'node:crypto';
import { teamsPendingUploads } from '@kortix/db';
import { eq, lt } from 'drizzle-orm';
import { db } from '../../shared/db';
import { loadTeamsBotCredentials, loadTeamsTenantForProject } from '../install-store';
import { sendActivity, sendCard } from '../teams-api';
import { buildNoticeCard } from './cards';
import { assertValidTeamsServiceUrl } from '../teams-service-url';
import { botConnectorToken, graphToken } from '../teams-auth';
import type { TeamsActivity, TeamsConversationRef } from './types';

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;

const ALLOWED_DOWNLOAD_HOST =
  /(^|\.)(sharepoint\.com|sharepoint-df\.com|svc\.ms|microsoft\.com|office\.com)$/i;

/**
 * Bot Framework attachment hosts — the only hosts that may receive the bot
 * connector token on the DOWNLOAD path.
 *
 * Deliberately narrower than `ALLOWED_SERVICE_HOST` (teams-service-url.ts),
 * which also allows `azurewebsites.net`, a customer-registrable namespace.
 * The download url is caller-supplied, so reusing the broad list let anyone
 * with project read point the proxy at their own `*.azurewebsites.net` host
 * and capture the bot connector token (CWE-918).
 */
const ALLOWED_BOT_ATTACHMENT_HOST = /(^|\.)(botframework\.com|botframework\.us|trafficmanager\.net)$/i;

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
  if (
    parsed.protocol !== 'https:' ||
    (!ALLOWED_DOWNLOAD_HOST.test(parsed.hostname) && !ALLOWED_BOT_ATTACHMENT_HOST.test(parsed.hostname))
  ) {
    return { ok: false, error: 'url must be an https Microsoft/SharePoint file URL', status: 400 };
  }

  const headers: Record<string, string> = {};
  if (ALLOWED_BOT_ATTACHMENT_HOST.test(parsed.hostname)) {
    // A Bot Framework attachment (an image pasted into the chat): the
    // connector token that posts our cards is the credential that reads it.
    const creds = await loadTeamsBotCredentials(projectId);
    const token = await botConnectorToken(creds).catch(() => null);
    if (!token) return { ok: false, error: 'could not mint a bot token', status: 502 };
    headers.Authorization = `Bearer ${token}`;
  } else if (/(^|\.)graph\.microsoft\.com$/i.test(parsed.hostname)) {
    const tenant = await loadTeamsTenantForProject(projectId);
    if (!tenant) return { ok: false, error: 'Teams not connected for this project', status: 404 };
    const creds = await loadTeamsBotCredentials(projectId);
    const token = await graphToken(tenant, creds).catch(() => null);
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
  /** Where the file goes. Absent = personal (the pre-existing consent-card path). */
  conversationType?: 'personal' | 'groupChat' | 'channel';
  /** The team's Microsoft 365 group id (channels only) — the drive the file is uploaded to. */
  teamGroupId?: string;
}

export type TeamsUploadResult =
  | { ok: true; delivered: 'consent_card'; uploadId: string }
  | { ok: true; delivered: 'inline' }
  | { ok: true; delivered: 'drive_link'; url: string };

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function imageContentType(filename: string): string | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return IMAGE_TYPES[ext] ?? null;
}

/**
 * Deliver a file from the sandbox into the conversation.
 *
 * - personal chat → the file-consent card (Teams stores the file in the
 *   recipient's OneDrive once they accept; `handleFileConsentInvoke` finishes).
 * - channel / group chat, image → inline attachment (base64 data URI).
 * - channel with a known team → upload to the team's SharePoint drive under
 *   `/Kortix/` and post an organization-scoped link.
 * Anything else is refused with a reason the agent can relay.
 */
export async function initiateTeamsUpload(
  projectId: string,
  args: TeamsUploadArgs,
): Promise<TeamsUploadResult | FileProxyError> {
  if (!args.serviceUrl || !args.conversationId || !args.filename || !args.contentBase64) {
    return {
      ok: false,
      error: 'serviceUrl, conversationId, filename and content_base64 are required',
      status: 400,
    };
  }
  // F-7: the caller-supplied serviceUrl must be a trusted Microsoft Bot Framework
  // endpoint, otherwise the bot connector token would be leaked to an arbitrary
  // host when the consent card is posted. Reject before persisting.
  if (!assertValidTeamsServiceUrl(args.serviceUrl)) {
    return {
      ok: false,
      error: 'serviceUrl must be an https Microsoft Bot Framework endpoint',
      status: 400,
    };
  }
  const size = Buffer.byteLength(args.contentBase64, 'base64');
  if (size <= 0) return { ok: false, error: 'empty file', status: 400 };
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `file exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`,
      status: 400,
    };
  }

  const ref: TeamsConversationRef = {
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    botId: args.botId,
    projectId,
  };
  const scope = args.conversationType ?? 'personal';
  if (scope !== 'personal') {
    const image = imageContentType(args.filename);
    if (image) {
      const posted = await sendActivity(ref, {
        ...(args.description ? { text: args.description } : {}),
        attachments: [
          { contentType: image, contentUrl: `data:${image};base64,${args.contentBase64}`, name: args.filename },
        ],
        type: 'message',
      });
      if (!posted) return { ok: false, error: 'failed to post the image', status: 502 };
      return { ok: true, delivered: 'inline' };
    }
    if (!args.teamGroupId) {
      return {
        ok: false,
        error:
          'Teams only accepts file transfers in a personal chat; in a group chat send images inline, or share a link. In a team channel the file can be uploaded to the team drive when the team is known.',
        status: 400,
      };
    }
    return uploadToTeamDrive(projectId, ref, { ...args, teamGroupId: args.teamGroupId });
  }

  await db
    .delete(teamsPendingUploads)
    .where(lt(teamsPendingUploads.expiresAt, new Date()))
    .catch(() => {});

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
    await db
      .delete(teamsPendingUploads)
      .where(eq(teamsPendingUploads.uploadId, uploadId))
      .catch(() => {});
    return { ok: false, error: 'failed to post the file consent card', status: 502 };
  }
  return { ok: true, delivered: 'consent_card', uploadId };
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DRIVE_FOLDER = 'Kortix';

/**
 * Does the channel this conversation belongs to live in that team? A Teams
 * channel conversation id IS the channel id (`19:…@thread.tacv2`, sometimes
 * with a `;messageid=…` suffix), so Graph answers this directly: the lookup
 * succeeds only when the team owns the channel.
 */
async function channelBelongsToTeam(
  token: string,
  teamGroupId: string,
  conversationId: string,
): Promise<boolean> {
  const channelId = conversationId.split(';')[0];
  if (!channelId.startsWith('19:')) return false;
  try {
    const res = await fetch(
      `${GRAPH}/teams/${encodeURIComponent(teamGroupId)}/channels/${encodeURIComponent(channelId)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Upload to the team's SharePoint drive and post an org-wide view link. Needs `Files.ReadWrite.All` (application) on the bot app. */
async function uploadToTeamDrive(
  projectId: string,
  ref: TeamsConversationRef,
  args: TeamsUploadArgs & { teamGroupId: string },
): Promise<TeamsUploadResult | FileProxyError> {
  const tenant = await loadTeamsTenantForProject(projectId);
  if (!tenant) return { ok: false, error: 'Teams not connected for this project', status: 404 };
  const creds = await loadTeamsBotCredentials(projectId);
  const token = await graphToken(tenant, creds).catch(() => null);
  if (!token) return { ok: false, error: 'could not mint a Graph token', status: 502 };

  // The drive is chosen by the TEAM THAT OWNS THIS CONVERSATION, verified
  // server-side — never by the client-supplied id alone. Without this, a
  // caller holding connector-write on one project could write into any
  // Microsoft 365 group's SharePoint drive in the tenant with the bot's
  // tenant-wide credential (CWE-862).
  if (!(await channelBelongsToTeam(token, args.teamGroupId, ref.conversationId))) {
    return { ok: false, error: 'that team does not own this conversation', status: 403 };
  }

  const bytes = Buffer.from(args.contentBase64, 'base64');
  const path = `${DRIVE_FOLDER}/${args.filename.replace(/[\\/:*?"<>|]/g, '_')}`;
  const put = await fetch(
    `${GRAPH}/groups/${encodeURIComponent(args.teamGroupId)}/drive/root:/${path}:/content`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    },
  ).catch(() => null);
  if (!put) return { ok: false, error: 'team drive upload failed: network', status: 502 };
  if (!put.ok) {
    const detail = (await put.text().catch(() => '')).slice(0, 200);
    const hint =
      put.status === 403 || put.status === 401
        ? ' The bot app needs the Files.ReadWrite.All application permission (admin consent) to write to team drives.'
        : '';
    return { ok: false, error: `team drive upload failed: HTTP ${put.status}${hint} ${detail}`.trim(), status: 502 };
  }
  const item = (await put.json().catch(() => ({}))) as {
    id?: string;
    webUrl?: string;
    parentReference?: { driveId?: string };
  };
  let url = item.webUrl ?? '';
  if (item.id && item.parentReference?.driveId) {
    const link = await fetch(
      `${GRAPH}/drives/${encodeURIComponent(item.parentReference.driveId)}/items/${encodeURIComponent(item.id)}/createLink`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'view', scope: 'organization' }),
        signal: AbortSignal.timeout(30_000),
      },
    ).catch(() => null);
    if (link?.ok) {
      const body = (await link.json().catch(() => ({}))) as { link?: { webUrl?: string } };
      if (body.link?.webUrl) url = body.link.webUrl;
    }
  }
  if (!url) return { ok: false, error: 'team drive upload succeeded but no link came back', status: 502 };

  const posted = await sendCard(
    ref,
    buildNoticeCard(`${args.description ? `${args.description}\n\n` : ''}📎 [${args.filename}](${url})`),
  );
  if (!posted) return { ok: false, error: 'failed to post the file link', status: 502 };
  return { ok: true, delivered: 'drive_link', url };
}

interface FileConsentValue {
  action?: 'accept' | 'decline';
  context?: { uploadId?: string };
  uploadInfo?: {
    uploadUrl?: string;
    contentUrl?: string;
    name?: string;
    uniqueId?: string;
    fileType?: string;
  };
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
    projectId: row?.projectId,
  };

  if (value.action !== 'accept') {
    await db
      .delete(teamsPendingUploads)
      .where(eq(teamsPendingUploads.uploadId, uploadId))
      .catch(() => {});
    return;
  }
  if (!row || !value.uploadInfo?.uploadUrl) {
    if (ref.serviceUrl && ref.conversationId) {
      await sendActivity(ref, {
        type: 'message',
        text: 'That upload expired — ask me to send the file again.',
      });
    }
    await db
      .delete(teamsPendingUploads)
      .where(eq(teamsPendingUploads.uploadId, uploadId))
      .catch(() => {});
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

  await db
    .delete(teamsPendingUploads)
    .where(eq(teamsPendingUploads.uploadId, uploadId))
    .catch(() => {});

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
