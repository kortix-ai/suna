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
