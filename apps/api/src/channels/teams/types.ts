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
    team?: { id?: string; name?: string };
    channel?: { id?: string };
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
}

export function extractTeamsAttachments(activity: TeamsActivity): TeamsAttachmentRef[] {
  const out: TeamsAttachmentRef[] = [];
  for (const a of activity.attachments ?? []) {
    if (a.contentType === 'application/vnd.microsoft.teams.file.download.info' && a.content?.downloadUrl) {
      out.push({ name: a.name ?? 'file', downloadUrl: a.content.downloadUrl, fileType: a.content.fileType });
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
  projectId: string;
  sessionId: string;
  originatingActivity: TeamsActivity;
}
