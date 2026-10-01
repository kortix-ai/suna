/**
 * Reads of the session state `@kortix/sdk` keeps: the transcript rows, the
 * runtime's status, and the pending questions and permission requests. The
 * SDK's live stream and transcript sync write that state; the app only reads
 * it, and writes its own optimistic sends.
 *
 * One place, so a screen never depends on how the SDK lays the state out
 * (messages and parts are separate slices there; requests are keyed by id).
 */
import { useMemo } from 'react';
import { useRuntimePendingStore, useSessionStateStore } from '@kortix/sdk/react';
import type { MessageWithParts, PermissionRequest, QuestionRequest, SessionStatus } from './types';

type SessionState = ReturnType<typeof useSessionStateStore.getState>;

function rowsOf(state: SessionState, sessionId: string | null | undefined): MessageWithParts[] | undefined {
  if (!sessionId) return undefined;
  const messages = state.messages[sessionId];
  // `buildSessionMessages` is the store's memoized join: the same array until
  // a message or one of its parts changes.
  return messages ? state.buildSessionMessages(sessionId, messages, state.parts) : undefined;
}

/** A session's transcript rows, or `undefined` while none are loaded. Subscribes. */
export function useSessionRows(sessionId: string | null | undefined): MessageWithParts[] | undefined {
  return useSessionStateStore((state) => rowsOf(state, sessionId));
}

/** A session's transcript rows now. Does not subscribe. */
export function sessionRows(sessionId: string | null | undefined): MessageWithParts[] {
  return rowsOf(useSessionStateStore.getState(), sessionId) ?? [];
}

/** The ids of every message the store holds for a session (optimistic ones included). */
export function sessionMessageIds(sessionId: string): string[] {
  return (useSessionStateStore.getState().messages[sessionId] ?? []).map((message) => message.id);
}

/** The runtime's last status frame for a session, or `undefined` before one arrived. Subscribes. */
export function useSessionStatus(sessionId: string | null | undefined): SessionStatus | undefined {
  return useSessionStateStore((state) => (sessionId ? state.sessionStatus[sessionId] : undefined));
}

export function sessionStatus(sessionId: string): SessionStatus | undefined {
  return useSessionStateStore.getState().sessionStatus[sessionId];
}

/** Set a session's status from this device (a send, a stop). The runtime's own frames replace it. */
export function setLocalSessionStatus(sessionId: string, status: SessionStatus): void {
  useSessionStateStore.getState().setStatus(sessionId, status, 'local');
}

const NO_QUESTIONS: QuestionRequest[] = [];
const NO_PERMISSIONS: PermissionRequest[] = [];

/** The questions waiting for an answer in a session, oldest first. Subscribes. */
export function usePendingQuestions(sessionId: string | null | undefined): QuestionRequest[] {
  const all = useRuntimePendingStore((state) => state.questions);
  return useMemo(() => {
    if (!sessionId) return NO_QUESTIONS;
    const mine = Object.values(all).filter((question) => question.sessionID === sessionId);
    return mine.length > 0 ? mine : NO_QUESTIONS;
  }, [all, sessionId]);
}

/** The permission requests waiting for a decision in a session, oldest first. Subscribes. */
export function usePendingPermissions(sessionId: string | null | undefined): PermissionRequest[] {
  const all = useRuntimePendingStore((state) => state.permissions);
  return useMemo(() => {
    if (!sessionId) return NO_PERMISSIONS;
    const mine = Object.values(all).filter((permission) => permission.sessionID === sessionId);
    return mine.length > 0 ? mine : NO_PERMISSIONS;
  }, [all, sessionId]);
}

/**
 * Show a message the user just sent, before the server echoes it. The SDK
 * replaces it with the echo (same message id, or the same part ids) and drops
 * it when a transcript read proves it was never delivered.
 */
export function addOptimisticMessage(sessionId: string, message: MessageWithParts): void {
  const parts = message.parts.map((part) => ({ ...part, sessionID: sessionId, messageID: message.info.id }));
  useSessionStateStore.getState().optimisticAdd(sessionId, message.info, parts);
}

/** The prompt inbox holds this optimistic message: it stays until its echo, across idle reads. */
export function markOptimisticAccepted(sessionId: string, messageId: string): void {
  useSessionStateStore.getState().markOptimisticInboxBacked(sessionId, messageId);
}

/** Drop an optimistic message that was never accepted (a refused or failed send). */
export function removeOptimisticMessage(sessionId: string, messageId: string): void {
  useSessionStateStore.getState().optimisticRemove(sessionId, messageId);
}

export function removeSessionMessage(sessionId: string, messageId: string): void {
  useSessionStateStore.getState().removeMessage(sessionId, messageId);
}
