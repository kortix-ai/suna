/**
 * Resend's `inbox.email.received` webhook
 * (https://resend.com/docs/webhooks/inboxes/email-received). It names the
 * inbox, thread and email; the email's headers are under `email`, never at the
 * `data` level. It carries no body: `session.ts` reads it with Retrieve Thread Email.
 */
export interface ResendInboxEmailReceivedEvent {
  type: string;
  created_at?: string;
  data: {
    inbox_id: string;
    thread_id: string;
    email_id: string;
    email?: {
      id?: string;
      /** `address` or `Name <address>`. */
      from?: string;
      to?: string[];
      cc?: string[];
      subject?: string | null;
      received_at?: string;
    };
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
