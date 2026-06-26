export interface TranscriptToolRef {
  tool: string;
  status: string | null;
}

export interface TranscriptFileRef {
  filename: string | null;
  mime: string | null;
}

export interface TranscriptMessage {
  role: string;
  text: string;
  tools?: TranscriptToolRef[];
  files?: TranscriptFileRef[];
  created?: string | null;
  completed?: string | null;
  reasoning_omitted?: boolean;
  error?: { name?: string; message?: string } | null;
}

export interface SessionInfo {
  status?: string;
  error?: string | null;
  branch_name?: string;
  opencode_session_id?: string | null;
  sandbox_url?: string | null;
  updated_at?: string;
}

export interface StartInfo {
  start?: {
    stage?: string;
    reason?: string | null;
    error?: string | null;
    opencode_session_id?: string | null;
    sandbox?: {
      external_id?: string | null;
      status?: string | null;
      base_url?: string | null;
    } | null;
  };
  error?: string;
}

export interface StreamState {
  session?: SessionInfo;
  start?: StartInfo;
  stream?: { attempt?: number; connected?: boolean };
  transcript?: {
    available: boolean;
    reason: string | null;
    message_count: number;
    messages: TranscriptMessage[];
  };
  error?: string;
}

export type StreamStatus = 'connecting' | 'live' | 'complete' | 'closed';

export type TimelineItem =
  | { id: string; kind: 'user'; text: string }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      files?: string[];
      reasoningOmitted?: boolean;
      error?: { name?: string; message?: string } | null;
    }
  | { id: string; kind: 'tool'; tool: string; status?: string; text: string };

export function buildTimeline(input: {
  prompt: string;
  messages: TranscriptMessage[];
}): TimelineItem[] {
  const items: TimelineItem[] = [{ id: 'initial-user', kind: 'user', text: input.prompt }];

  input.messages
    .filter((message) => message.text.trim() || (message.tools?.length ?? 0) > 0)
    .forEach((message, index) => {
      const tools = message.tools?.filter((t) => t.tool) ?? [];
      const files =
        message.files?.map((f) => f.filename).filter((f): f is string => Boolean(f)) ?? [];
      if (message.role === 'tool' || tools.length > 0) {
        items.push({
          id: `transcript-tool-${index}`,
          kind: 'tool',
          tool: tools[0]?.tool ?? 'tool',
          status: tools[0]?.status ?? 'completed',
          text: message.text,
        });
      } else {
        items.push({
          id: `transcript-${message.role}-${index}`,
          kind: message.role === 'user' ? 'user' : 'assistant',
          text: message.text,
          files,
          reasoningOmitted: message.reasoning_omitted,
          error: message.error ?? null,
        });
      }
    });

  return items;
}

export function toStatusTone(
  status?: string | null,
): 'success' | 'warning' | 'destructive' | 'info' | 'neutral' {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'ready':
    case 'success':
      return 'success';
    case 'running':
    case 'pending':
    case 'in_progress':
      return 'info';
    case 'error':
    case 'failed':
      return 'destructive';
    case 'stopped':
    case 'paused':
      return 'warning';
    default:
      return 'neutral';
  }
}
