'use client';

/**
 * All the chat state + actions for one session, in one place: live messages
 * (useSessionSync), interactive prompts (the pending store), the server-side
 * model/agent sources + per-session selection, optimistic send, the unified
 * cancel, and the "new session" stash replay. The view (Thread) just renders
 * what this returns.
 */

import { useRuntimePhase } from '@/lib/runtime';
import { useSessionPicks } from '@/lib/session-picks';
import { clearStartStash, readStartStash } from '@/lib/session-start';
import {
  type ModelKey,
  useAbortOpenCodeSession,
  useExecuteOpenCodeCommand,
  useOpenCodePendingStore,
  useProjectConfig,
  useProjectModels,
  useSendOpenCodeMessage,
  useSessionSync,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

export function useChat({
  projectId,
  sessionId,
  ocSessionId,
}: {
  projectId: string;
  sessionId: string;
  ocSessionId: string;
}) {
  const { messages, isBusy, isLoading } = useSessionSync(ocSessionId);
  const send = useSendOpenCodeMessage();
  const abort = useAbortOpenCodeSession();
  const execCommand = useExecuteOpenCodeCommand();
  const phase = useRuntimePhase();

  // Interactive prompts live in the pending store (the SSE stream writes them
  // there). Select the stable maps, derive this session's items via memo.
  const questionMap = useOpenCodePendingStore((s) => s.questions);
  const permissionMap = useOpenCodePendingStore((s) => s.permissions);
  const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);
  const removePermission = useOpenCodePendingStore((s) => s.removePermission);
  const questions = useMemo(
    () => Object.values(questionMap).filter((q) => (q as any).sessionID === ocSessionId),
    [questionMap, ocSessionId],
  );
  const permissions = useMemo(
    () => Object.values(permissionMap).filter((p) => (p as any).sessionID === ocSessionId),
    [permissionMap, ocSessionId],
  );

  // Server-side capabilities (models/agents/commands/default agent) + the
  // per-session selection. All pre-runtime; the runtime is only for messages.
  const models = useProjectModels(projectId);
  const agents = useVisibleAgents({ projectId });
  const config = useProjectConfig(projectId);
  const picks = useSessionPicks(sessionId);

  // Optimistic send: show the user's message instantly until a NEW user message
  // lands in the thread (count grows). Counting is robust to duplicate or
  // server-normalized text, where a text-equality match would clear too early or
  // never clear (wedging the composer on Stop). A timeout backstops a lost echo.
  const userMsgCount = useMemo(
    () => messages.filter((m) => m.info.role === 'user').length,
    [messages],
  );
  const [pending, setPending] = useState<string | null>(null);
  const pendingBaseCount = useRef(0);
  useEffect(() => {
    if (pending && userMsgCount > pendingBaseCount.current) setPending(null);
  }, [userMsgCount, pending]);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 30_000);
    return () => clearTimeout(t);
  }, [pending]);

  const sendMessage = (
    text: string,
    override?: { model?: ModelKey | null; agent?: string | null },
  ) => {
    pendingBaseCount.current = userMsgCount;
    setPending(text);
    const model = override?.model ?? picks.model;
    const agent = override?.agent ?? picks.agent;
    const options = { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
    send.mutate(
      {
        sessionId: ocSessionId,
        parts: [{ type: 'text', text }],
        ...(Object.keys(options).length ? { options } : {}),
      },
      {
        onError: () => {
          toast.error('Could not send your message');
          setPending(null);
        },
      },
    );
  };

  // Run a project slash-command (server-side `/command` endpoint), distinct from
  // a text prompt. Output streams back over SSE like any turn.
  const runCommand = (command: string, args: string) => {
    execCommand.mutate(
      { sessionId: ocSessionId, command, args },
      { onError: () => toast.error(`Could not run /${command}`) },
    );
  };

  // The one true cancel: abort the run AND drop any pending prompt.
  const cancel = () => {
    abort.mutate(ocSessionId);
    questions.forEach((q) => removeQuestion((q as any).id));
    permissions.forEach((p) => removePermission((p as any).id));
    setPending(null);
  };

  // Replay the "new session" hand-off: send the stashed prompt with the chosen
  // model + agent once the runtime is ready and the thread is empty (once).
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || phase !== 'ready' || isLoading) return;
    const stash = readStartStash(sessionId);
    if (!stash) return;
    startedRef.current = true;
    clearStartStash(sessionId);
    if (messages.length > 0) return;
    if (stash.model) picks.setModel(stash.model);
    if (stash.agent) picks.setAgent(stash.agent);
    sendMessage(stash.prompt, { model: stash.model, agent: stash.agent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isLoading, messages.length, sessionId]);

  const hasPending = questions.length > 0 || permissions.length > 0;
  return {
    messages,
    isLoading,
    isBusy,
    pending,
    busy: isBusy || !!pending,
    phase,
    questions,
    permissions,
    removeQuestion,
    removePermission,
    models,
    agents,
    defaultAgent: config?.open_code_default_agent ?? null,
    commands: config?.commands ?? [],
    picks,
    hasPending,
    sendMessage,
    runCommand,
    cancel,
  };
}
