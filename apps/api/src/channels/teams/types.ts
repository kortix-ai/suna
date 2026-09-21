import type { StreamTaskChunk } from '../slack-api';

export interface TeamsActivity {
  type: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string; name?: string };
  channelData?: {
    tenant?: { id?: string };
    team?: { id?: string; name?: string; aadGroupId?: string };
    channel?: { id?: string; name?: string };
  };
  replyToId?: string;
  entities?: Array<Record<string, unknown>>;
  name?: string;
  action?: string;
  membersAdded?: Array<{ id?: string; aadObjectId?: string }>;
  value?: unknown;
  attachments?: Array<{
    contentType?: string;
    contentUrl?: string;
    name?: string;
    content?: { downloadUrl?: string; uniqueId?: string; fileType?: string };
  }>;
}

export interface TeamsAttachmentRef {
  name: string;
  downloadUrl: string;
  fileType?: string;
  /** An image the agent can look at directly once downloaded. */
  isImage?: boolean;
}

/** Teams sends inline images as the wildcard type `image/*`, with no filename. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
};

export function extractTeamsAttachments(activity: TeamsActivity): TeamsAttachmentRef[] {
  const out: TeamsAttachmentRef[] = [];
  for (const a of activity.attachments ?? []) {
    // A file shared from OneDrive (personal chat): a pre-authorized download URL.
    if (a.contentType === 'application/vnd.microsoft.teams.file.download.info' && a.content?.downloadUrl) {
      out.push({ name: a.name ?? 'file', downloadUrl: a.content.downloadUrl, fileType: a.content.fileType });
      continue;
    }
    // An image pasted or dragged into the composer: `image/*` with a Bot
    // Framework attachment URL that needs the bot connector token to fetch
    // (channels/teams/file-proxy.ts attaches it).
    if (a.contentType?.startsWith('image/') && a.contentUrl) {
      const subtype = a.contentType.slice('image/'.length).split(';')[0].trim().toLowerCase();
      // `image/*` carries no real subtype — name the file without a misleading
      // extension rather than `image.*`, which is not a filename.
      const ext = IMAGE_EXTENSIONS[subtype];
      out.push({
        name: a.name ?? (ext ? `image.${ext}` : 'image'),
        downloadUrl: a.contentUrl,
        ...(ext ? { fileType: ext } : {}),
        isImage: true,
      });
    }
  }
  return out;
}

export interface TeamsConversationRef {
  serviceUrl: string;
  conversationId: string;
  botId?: string;
  fromId?: string;
  tenantId?: string;
  projectId?: string;
}

export interface TeamsChannelRef {
  platform: 'teams';
  serviceUrl: string;
  conversationId: string;
  botId?: string;
  fromId?: string;
}

export interface TeamsLiveTurn {
  conversationId: string;
  tenantId: string;
  serviceUrl: string;
  botId?: string;
  fromId?: string;
  triggerActivityId: string;
  messageActivityId: string;
  steps: StreamTaskChunk[];
  expiry: number;
  finalized: boolean;
  /** When the row last changed — a turn that has not moved is not "in flight". */
  updatedAt?: number;
  projectId: string;
  sessionId: string;
  originatingActivity: TeamsActivity;
}

/** Does this message carry an image the model has to be able to see? */
export function teamsMessageHasImage(activity: TeamsActivity): boolean {
  return extractTeamsAttachments(activity).some((a) => a.isImage === true);
}
