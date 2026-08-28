'use client';

import { create } from 'zustand';
import {
  inboxObservationSupersedes,
  type AbortReceipt,
  type SendReceipt,
  type WorkingInboxInput,
} from '../../core/session/working';

/**
 * The LOCAL-ISH inputs to `projectWorking`, one set per Kortix session.
 *
 * They live in a store rather than in each caller's `useState` because more
 * than one place mounts `useSessionWorking` for the same session — `useSession`
 * on the route, the composer, the session panel — and they all share one
 * react-query cache entry for `GET .../turn`. When each held its own receipt,
 * the observer WITHOUT one polled on its own timer, wrote an uninformed "no
 * turns" read into that shared entry, and defeated the receipt the other one
 * was standing on: the composer flipped Stop back to Send mid-send. One set of
 * inputs per session is what makes "one answer" true for every mount point.
 *
 * Nothing here is authority. Every field is bounded by the projection
 * (`OPTIMISTIC_RECEIPT_MAX_MS`, `OPTIMISTIC_ABORT_MAX_MS`,
 * `INBOX_OBSERVATION_MAX_MS`), so a stale entry ages out rather than latching.
 */
interface SessionWorkingState {
  /** Keyed by KORTIX session id — the id `GET .../turn` is addressed by, not
   *  the OpenCode wire id the sync store uses. */
  receipts: Record<string, SendReceipt | null>;
  aborts: Record<string, AbortReceipt>;
  inbox: Record<string, WorkingInboxInput>;

  /** Record that a prompt just left this tab. Replaces any previous receipt:
   *  the newest send is the one the UI is standing on. Also releases any
   *  pending stop — sending is the user saying they are not stopping. */
  noteSendReceipt: (
    sessionId: string,
    receipt: { messageId: string; turnId?: string | null; atMs: number },
  ) => void;
  /** The server durably accepted `messageId`. Ignored when a NEWER send has
   *  already replaced the receipt — otherwise the old response would release a
   *  receipt for a send it knows nothing about. */
  acceptSendReceipt: (sessionId: string, messageId: string, atMs: number) => void;
  /**
   * Nothing is coming: a refused send, Stop, or leaving the session.
   *
   * `messageId` names the send being dropped, and is required of every caller
   * that HAS one, for the same reason `acceptSendReceipt` checks it: a
   * `/compact` rejected at T+600ms used to delete the receipt of an ordinary
   * prompt submitted at T+500ms whose POST was still on the wire, and an
   * uninformed `/turn` read then flipped the composer back to Send mid-send.
   * Omit it only where nothing is coming for ANY send — Stop, unmount.
   */
  clearSendReceipt: (sessionId: string, messageId?: string) => void;
  /**
   * Record that this tab asked the running turn to end. Keeps the FIRST
   * instant while a stop is still unsettled: two paths issue the same cancel
   * (the SDK's `cancel()` and the host's `issueSessionCancel`) and restamping
   * would extend the bar every time either one fired again.
   */
  noteAbortReceipt: (sessionId: string, atMs: number) => void;
  /** The server acknowledged the cancel. Stamped once — the first
   *  acknowledgement is the one a server read can be measured against. */
  settleAbortReceipt: (sessionId: string, atMs: number) => void;
  /** One reading of the durable prompt inbox. `atMs` is this tab's clock at
   *  ISSUE/RECEIVE time (age); `serverAtMs` is the server's `observed_at`
   *  (ordering) when the endpoint supplied one. See `WorkingInboxInput`. */
  noteInboxPending: (sessionId: string, pending: number, atMs: number, serverAtMs?: number) => void;
  /** `POST .../prompts` returned: the row EXISTS, and the server said so. Raise
   *  the inbox floor to at least one pending row, covering the gap between that
   *  response and the list query refetching — a `/turn` poll landing in that gap
   *  answers "no turns" honestly and used to flip the composer back to Send with
   *  the user's prompt already queued. `serverAtMs` is the response's
   *  `observed_at`: the write's place on the server clock, which is what bars a
   *  read issued BEFORE the POST from erasing the row after it settles. */
  notePromptAccepted: (sessionId: string, atMs: number, serverAtMs?: number) => void;
  /** Drop every input this session holds. Called by `useSessionWorking` when
   *  the LAST observer of the session unmounts — the maps otherwise accumulate
   *  one entry per session visited for the tab's lifetime. Correctness never
   *  depended on it (every field is bounded), this is leak hygiene. */
  clearSession: (sessionId: string) => void;
  reset: () => void;
}

export const useSessionWorkingStore = create<SessionWorkingState>()((set) => ({
  receipts: {},
  aborts: {},
  inbox: {},

  noteSendReceipt: (sessionId, receipt) =>
    set((state) => {
      if (!sessionId) return state;
      const { [sessionId]: _stopped, ...aborts } = state.aborts;
      return {
        receipts: {
          ...state.receipts,
          [sessionId]: { ...receipt, acceptedAtMs: null },
        },
        // A send releases the stop. Leaving it would bar `/turn` from reporting
        // the turn this very send is about to start.
        aborts,
      };
    }),

  acceptSendReceipt: (sessionId, messageId, atMs) =>
    set((state) => {
      const current = state.receipts[sessionId];
      if (!current || current.messageId !== messageId || current.acceptedAtMs != null) {
        return state;
      }
      return { receipts: { ...state.receipts, [sessionId]: { ...current, acceptedAtMs: atMs } } };
    }),

  clearSendReceipt: (sessionId, messageId) =>
    set((state) => {
      const current = state.receipts[sessionId];
      if (!(sessionId in state.receipts)) return state;
      if (messageId !== undefined && current?.messageId !== messageId) return state;
      const { [sessionId]: _dropped, ...rest } = state.receipts;
      return { receipts: rest };
    }),

  noteAbortReceipt: (sessionId, atMs) =>
    set((state) => {
      if (!sessionId) return state;
      const current = state.aborts[sessionId];
      if (current && current.settledAtMs == null) return state;
      return { aborts: { ...state.aborts, [sessionId]: { atMs, settledAtMs: null } } };
    }),

  settleAbortReceipt: (sessionId, atMs) =>
    set((state) => {
      const current = state.aborts[sessionId];
      if (!current || current.settledAtMs != null) return state;
      return { aborts: { ...state.aborts, [sessionId]: { ...current, settledAtMs: atMs } } };
    }),

  noteInboxPending: (sessionId, pending, atMs, serverAtMs) =>
    set((state) => {
      if (!sessionId) return state;
      const current = state.inbox[sessionId];
      // Readings settle in whatever order the network gives them; only the
      // newest OBSERVATION may stand, or a late older one would walk the
      // projection backwards. Server-stamped readings rank on the server's own
      // clock — see `inboxObservationSupersedes`.
      const candidate: WorkingInboxInput = {
        pending,
        atMs,
        ...(serverAtMs != null ? { serverAtMs } : {}),
      };
      if (!inboxObservationSupersedes(candidate, current)) return state;
      if (
        current &&
        current.atMs === atMs &&
        current.pending === pending &&
        current.serverAtMs === candidate.serverAtMs
      ) {
        return state;
      }
      return { inbox: { ...state.inbox, [sessionId]: candidate } };
    }),

  notePromptAccepted: (sessionId, atMs, serverAtMs) =>
    set((state) => {
      if (!sessionId) return state;
      const current = state.inbox[sessionId];
      if (current && current.atMs > atMs) return state;
      // A reading whose server stamp postdates this POST already answered for
      // it — the acceptance must not walk the ordering key backwards.
      if (current?.serverAtMs != null && serverAtMs != null && current.serverAtMs > serverAtMs) {
        return state;
      }
      const pending = Math.max(1, current?.pending ?? 0);
      const merged =
        serverAtMs != null || current?.serverAtMs != null
          ? Math.max(
              serverAtMs ?? Number.NEGATIVE_INFINITY,
              current?.serverAtMs ?? Number.NEGATIVE_INFINITY,
            )
          : undefined;
      return {
        inbox: {
          ...state.inbox,
          [sessionId]: { pending, atMs, ...(merged != null ? { serverAtMs: merged } : {}) },
        },
      };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (
        !(sessionId in state.receipts) &&
        !(sessionId in state.aborts) &&
        !(sessionId in state.inbox)
      ) {
        return state;
      }
      const { [sessionId]: _r, ...receipts } = state.receipts;
      const { [sessionId]: _a, ...aborts } = state.aborts;
      const { [sessionId]: _i, ...inbox } = state.inbox;
      return { receipts, aborts, inbox };
    }),

  reset: () => set({ receipts: {}, aborts: {}, inbox: {} }),
}));
