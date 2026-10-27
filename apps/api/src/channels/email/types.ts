/**
 * Resend's `inbox.email.received` webhook. It names the inbox, thread and
 * email but carries no body: `session.ts` reads it with Retrieve Thread Email.
 */
export interface ResendInboxEmailReceivedEvent {
  type: string;
  created_at?: string;
  data: {
    inbox_id: string;
    thread_id: string;
    email_id: string;
    from?: string;
    to?: string[];
    cc?: string[];
    subject?: string | null;
    created_at?: string;
  };
}

/** One received email as the session flow uses it: the event plus its body. */
export interface InboundEmail {
  inboxId: string;
  threadId: string;
  emailId: string;
  from: string;
  to: string[];
  subject: string | null;
  text: string;
  attachments: Array<{ id: string; filename: string | null; size: number | null }>;
}
