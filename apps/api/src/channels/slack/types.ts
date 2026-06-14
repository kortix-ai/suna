import type { StreamTaskChunk } from '../slack-api';

export interface QuestionInfo {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
}

export interface LiveTurn {
  channel: string;
  ts: string;
  token: string;
  triggerTs: string;
  steps: StreamTaskChunk[];
  expiry: number;
  finalized: boolean;
  projectId: string;
  sessionId: string;
  teamId: string;
  originatingEvent: SlackEvent;
}

export interface PendingAsk {
  askId: string;
  questions: QuestionInfo[];
  resolve: (answers: string[][]) => void;
  expiry: number;
  channel: string;
  messageTs: string | null;
  token: string;
  sessionId: string;
  projectId: string;
  teamId: string;
  originatingEvent: SlackEvent;
}

export type ProjectResolution =
  | { kind: 'project'; projectId: string }
  | { kind: 'ambiguous'; projectIds: string[] }
  | { kind: 'pending' }
  | { kind: 'none' };

export type SlashResponse = { response_type: 'ephemeral' | 'in_channel'; text?: string; blocks?: unknown[] };

export type EventClass = 'mention' | 'dm' | 'follow_up' | 'ignore';

export interface HomeProjectRow { projectId: string; name: string; repoUrl: string }
export interface HomeRecentRow { projectId: string; lastMessageAt: Date; threadId: string }

export interface SlackEnvelope {
  type: string;
  team_id?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
}

export interface SlackEvent {
  type: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  team?: string;
  tab?: 'home' | 'messages';
}

export interface SlackInteractionPayload {
  type: string;
  team?: { id: string };
  user?: { id: string };
  channel?: { id: string };
  message?: { ts: string; thread_ts?: string };
  actions?: Array<{
    action_id?: string;
    value?: string;
    text?: { type?: string; text?: string };
    // static_select fires block_actions with the picked option here.
    selected_option?: { value?: string; text?: { text?: string } } | null;
  }>;
  response_url?: string;
  state?: {
    values?: Record<
      string,
      Record<
        string,
        {
          type?: string;
          value?: string;
          selected_option?: { value?: string } | null;
          selected_options?: Array<{ value?: string }>;
        }
      >
    >;
  };
}
