'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  createAcpProjection,
  createAcpSessionController,
  type AcpContentBlock,
  type AcpSessionControllerSnapshot,
} from '../core/acp';

const EMPTY_SNAPSHOT: AcpSessionControllerSnapshot = {
  ready: false,
  sending: false,
  connection: 'idle',
  error: null,
  projection: createAcpProjection(''),
  configOptions: [],
};
const noopSubscribe = () => () => {};

export async function cancelAcpSession(controller: { cancel(): Promise<void> } | null): Promise<void> {
  if (!controller) return;
  await controller.cancel();
}

export function useAcpSessionRuntime(input: {
  runtimeUrl: string | null;
  sessionId: string | null;
  enabled: boolean;
}) {
  const controller = useMemo(
    () =>
      input.runtimeUrl && input.sessionId
        ? createAcpSessionController({
            runtimeUrl: input.runtimeUrl,
            sessionId: input.sessionId,
          })
        : null,
    [input.runtimeUrl, input.sessionId],
  );

  useEffect(() => {
    if (!input.enabled || !controller) return;
    void controller.connect().catch(() => {});
    return () => controller.close();
  }, [controller, input.enabled]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    controller?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );

  const send = useCallback(
    (prompt: AcpContentBlock[], options?: { model?: string | null; agent?: string | null }) => {
      if (!controller) throw new Error('ACP session runtime is not ready');
      return controller.send(prompt, options);
    },
    [controller],
  );
  const cancel = useCallback(async () => {
    await cancelAcpSession(controller);
  }, [controller]);
  const runCommand = useCallback(
    (command: string, args: string, options?: { model?: string | null; agent?: string | null }) => {
      if (!controller) throw new Error('ACP session runtime is not ready');
      return controller.runCommand(command, args, options);
    },
    [controller],
  );
  const answerPermission = useCallback(
    (requestId: string, reply: 'once' | 'always' | 'reject') => {
      if (!controller) throw new Error('ACP session runtime is not ready');
      return controller.answerPermission(requestId, reply);
    },
    [controller],
  );
  const answerQuestion = useCallback(
    (requestId: string, answers: string[][]) => {
      if (!controller) throw new Error('ACP session runtime is not ready');
      return controller.answerQuestion(requestId, answers);
    },
    [controller],
  );
  const rejectQuestion = useCallback(
    (requestId: string) => {
      if (!controller) throw new Error('ACP session runtime is not ready');
      return controller.rejectQuestion(requestId);
    },
    [controller],
  );

  return {
    ...snapshot,
    send,
    cancel,
    runCommand,
    answerPermission,
    answerQuestion,
    rejectQuestion,
  };
}
