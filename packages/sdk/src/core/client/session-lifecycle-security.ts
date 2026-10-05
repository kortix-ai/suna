import * as P from '../rest/projects-client';

import type { SessionBindingContext } from './session-context';
export function bindSessionLifecycleSecurity(ctx: SessionBindingContext) {
  return {
    reminders: {
      list: () => P.listSessionReminders(ctx.projectId, ctx.sessionId),
      create: (input: Parameters<typeof P.createSessionReminder>[2]) =>
        P.createSessionReminder(ctx.projectId, ctx.sessionId, input),
      update: (reminderId: string, input: Parameters<typeof P.updateSessionReminder>[3]) =>
        P.updateSessionReminder(ctx.projectId, ctx.sessionId, reminderId, input),
      remove: (reminderId: string) =>
        P.deleteSessionReminder(ctx.projectId, ctx.sessionId, reminderId),
    },
    /** Per-session audit trail of connector-gated agent actions. */
    audit: (limit?: number, options?: Parameters<typeof P.getSessionAudit>[3]) =>
      P.getSessionAudit(ctx.projectId, ctx.sessionId, limit, options),
    attachments: {
      upload: (file: File, options?: Parameters<typeof P.uploadSessionAttachment>[3]) =>
        P.uploadSessionAttachment(ctx.projectId, ctx.sessionId, file, options),
      read: (attachmentId: string, signal?: AbortSignal) =>
        P.fetchSessionAttachment(
          `kortix-attachment://${ctx.projectId}/${ctx.sessionId}/${attachmentId}`,
          signal,
        ),
    },
    /** Compact server-side transcript read (text + tool calls, no tool inputs/outputs) — callable with project-scoped session tokens. */
    transcript: (options?: Parameters<typeof P.getSessionTranscript>[2]) =>
      P.getSessionTranscript(ctx.projectId, ctx.sessionId, options),
    /** Who wrote each message: a member, or another session's agent. */
    messageAuthors: () => P.getSessionMessageAuthors(ctx.projectId, ctx.sessionId),
    /** Which model answered each turn, and what Kortix billed for it. */
    modelUsage: () => P.getSessionModelUsage(ctx.projectId, ctx.sessionId),
    /** The DURABLE server-side transcript mirror, in sync-store shape
     *  (OpenCode message envelopes verbatim, attachment bytes and tool
     *  inputs/outputs stripped). This is the read that answers while the
     *  sandbox is stopped or still waking. */
    transcriptSync: (options?: Parameters<typeof P.getSessionTranscriptSync>[2]) =>
      P.getSessionTranscriptSync(ctx.projectId, ctx.sessionId, options),
    /** Which turns are running right now, and how did the last one end?
     *  Server truth from the control plane's lifecycle authority, independent
     *  of the live stream. */
    turn: () => P.getSessionTurn(ctx.projectId, ctx.sessionId),
    /** This session's SERVER-SIDE prompt inbox: the prompts it still owes the
     *  user. Durable, so it survives a closed tab and is the same list on
     *  every device. */
    prompts: {
      create: (input: P.CreateSessionPromptInput) =>
        P.createSessionPrompt(ctx.projectId, ctx.sessionId, input),
      list: () => P.listSessionPrompts(ctx.projectId, ctx.sessionId),
      remove: (promptId: string) => P.deleteSessionPrompt(ctx.projectId, ctx.sessionId, promptId),
      retry: (promptId: string) => P.retrySessionPrompt(ctx.projectId, ctx.sessionId, promptId),
      /** Replace a waiting prompt's text in place; sends nothing. */
      edit: (promptId: string, text: string) =>
        P.editSessionPrompt(ctx.projectId, ctx.sessionId, promptId, text),
      /** Hold (or release) the whole queue — what the Stop button writes. */
      hold: (held: boolean) => P.holdSessionPrompts(ctx.projectId, ctx.sessionId, held),
    },
    /**
     * Resolve THIS handle's own runtime (idempotent): provisions/resumes the
     * sandbox (long-poll until ready) and caches the resolved OpenCode session
     * id + runtime URL + sandbox id for every other call on this handle. Call
     * this (or `send`/`abort`, which call it internally) before `.runtime`,
     * `.health()`, `.previewUrl()`, or `.proxyUrl()` — those throw
     * `SessionNotReadyError` instead of falling back to whatever sandbox
     * happens to be globally active.
     */
    ensureReady: ctx.ensureReady,
  };
}
