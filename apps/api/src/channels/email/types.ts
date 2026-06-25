export interface AgentMailAddressedMessage {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  timestamp?: string;
  from?: string;
  from_?:
    | string
    | string[]
    | Array<{ email?: string; address?: string; name?: string }>;
  reply_to?: string[];
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  preview?: string;
  text?: string;
  html?: string;
  extracted_text?: string;
  extracted_html?: string;
  attachments?: Array<{
    attachment_id: string;
    filename?: string;
    size: number;
    content_type?: string;
  }>;
}

export interface AgentMailThread {
  inbox_id: string;
  thread_id: string;
  subject?: string;
  preview?: string;
  message_count?: number;
}

export interface AgentMailMessageReceivedEvent {
  type: "event";
  event_type:
    | "message.received"
    | "message.received.spam"
    | "message.received.blocked"
    | "message.received.unauthenticated";
  event_id: string;
  message: AgentMailAddressedMessage;
  thread: AgentMailThread;
}
