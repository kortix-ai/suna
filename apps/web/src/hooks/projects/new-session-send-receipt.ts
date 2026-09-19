'use client';

import { useSessionWorkingStore } from '@kortix/sdk/react';

/**
 * The working projection covers a new session's first prompt from the Send
 * press, not from the first server read.
 *
 * A send from the project home creates (or claims) the session and hands the
 * prompt over as a durable inbox row inside that one request. Until this, the
 * path filed nothing: `startSessionWithPrompt` is the only producer that
 * records a send receipt, and it runs for held uploads only. So between the
 * navigation and the first `/prompts` or `/turn` read, `projectWorking` had no
 * input at all and answered `idle` — the composer showed Send and the
 * transcript drew no waiting row, for a prompt the server was already running.
 *
 * The receipt is the same pair `startSessionWithPrompt` files, keyed to the
 * session the send created. Nothing here is authority: the projection bounds
 * every receipt (`OPTIMISTIC_RECEIPT_MAX_MS`), so a lost response ages out
 * instead of latching Stop.
 */

/**
 * The client message id the API mints for a `create.pending_prompt` row
 * (`convertPendingPromptToInboxRow`, `apps/api/.../pending-prompt.ts`). The
 * warm claim inserts the same row, so both paths name the same send.
 */
export function pendingFirstPromptMessageId(sessionId: string): string {
  return `pending:${sessionId}`;
}

/** File a receipt for this send, or file nothing. */
export type SendReceiptPlan = { file: false } | { file: true; messageId: string };

/**
 * Which receipt a new-session create files.
 *
 * Only a create that CARRIES the prompt is a send. The sidebar's "New session"
 * creates an empty session, and a receipt for it would show Stop in a composer
 * the user has not typed into.
 */
export function planNewSessionSendReceipt(input: {
  sessionId: string;
  hasPendingPrompt: boolean;
}): SendReceiptPlan {
  if (!input.sessionId || !input.hasPendingPrompt) return { file: false };
  return { file: true, messageId: pendingFirstPromptMessageId(input.sessionId) };
}

/** The slice of the SDK working store a send writes. */
export interface SendReceiptStore {
  noteSendReceipt(sessionId: string, receipt: { messageId: string; atMs: number }): void;
  acceptSendReceipt(sessionId: string, messageId: string, atMs: number): void;
  notePromptAccepted(sessionId: string, atMs: number, serverAtMs?: number): void;
  clearSendReceipt(sessionId: string, messageId?: string): void;
}

export interface NewSessionSendReceipt {
  /** The server durably holds the prompt (the create or claim returned). */
  accept(atMs: number): void;
  /** Nothing is coming: the create or claim was refused. */
  clear(): void;
}

const NO_RECEIPT: NewSessionSendReceipt = { accept: () => {}, clear: () => {} };

/**
 * File the send receipt for a create that carries the first prompt, and return
 * the two ways it settles. A create without a prompt returns no-ops.
 *
 * `sentAtMs` is the Send press, not the POST: the create can wait on finished
 * uploads, and the projection measures the wait the user is actually watching.
 */
export function fileNewSessionSendReceipt(input: {
  sessionId: string;
  hasPendingPrompt: boolean;
  sentAtMs: number;
  /** Injected in tests; the SDK working store otherwise. */
  store?: SendReceiptStore;
}): NewSessionSendReceipt {
  const plan = planNewSessionSendReceipt(input);
  if (!plan.file) return NO_RECEIPT;
  const { sessionId } = input;
  const { messageId } = plan;
  // Read per call, like every other producer: the store is a module singleton
  // and a captured snapshot would write into a reset state after a sign-out.
  const store = () => input.store ?? useSessionWorkingStore.getState();
  store().noteSendReceipt(sessionId, { messageId, atMs: input.sentAtMs });
  return {
    accept: (atMs) => {
      store().acceptSendReceipt(sessionId, messageId, atMs);
      // The row EXISTS server-side from this response on. Raising the inbox
      // floor covers the gap until `/prompts` lists it — a `/turn` poll landing
      // in that gap answers "no turns" honestly and would flip Send back.
      store().notePromptAccepted(sessionId, atMs);
    },
    // Named, so a slow refusal cannot drop a receipt a later send now owns.
    clear: () => store().clearSendReceipt(sessionId, messageId),
  };
}
