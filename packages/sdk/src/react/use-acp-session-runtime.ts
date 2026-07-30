'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  type AcpContentBlock,
  type AcpSessionController,
  type AcpSessionControllerOptions,
  type AcpSessionControllerSnapshot,
  createAcpProjection,
  createAcpSessionController,
} from '../core/acp';
import { platformConfig } from '../core/http/config';
import { persistProjectSessionAcpIdentity } from '../core/rest/projects-client/session-acp-identity';
import { buildProjectAcpEndpoint } from '../core/session/runtime-transport';

type SessionRuntimeHarness = 'claude' | 'codex' | 'opencode' | 'pi';

const EMPTY_SNAPSHOT: AcpSessionControllerSnapshot = {
  ready: false,
  sending: false,
  connection: 'idle',
  error: null,
  projection: createAcpProjection(''),
  configOptions: [],
  rewind: null,
};
const noopSubscribe = () => () => {};

export async function cancelAcpSession(
  controller: { cancel(): Promise<void> } | null,
): Promise<void> {
  if (!controller) return;
  await controller.cancel();
}

type AcpSessionRuntimeControllerInput = {
  projectId: string;
  runtimeUrl: string | null;
  sessionId: string;
  acpServerId: string | null;
  acpSessionId: string | null;
  runtimeHarness: SessionRuntimeHarness | null;
  nativeAgent?: string | null;
  legacySessionId?: string | null;
};

export function createAcpSessionRuntimeController(
  input: AcpSessionRuntimeControllerInput,
  factory: (
    options: AcpSessionControllerOptions,
  ) => AcpSessionController = createAcpSessionController,
): AcpSessionController | null {
  if (!input.runtimeUrl) return null;
  const managed = !!input.acpServerId && input.acpServerId === input.sessionId;
  if (!managed) {
    const legacySessionId = input.legacySessionId ?? input.acpSessionId;
    return legacySessionId
      ? factory({
          runtimeUrl: input.runtimeUrl,
          sessionId: legacySessionId,
        })
      : null;
  }
  if (!input.runtimeHarness || !input.acpServerId) return null;
  return factory({
    endpoint: buildProjectAcpEndpoint(
      platformConfig().backendUrl,
      input.projectId,
      input.sessionId,
    ),
    durableTranscript: true,
    sessionId: input.sessionId,
    acpServerId: input.acpServerId,
    acpSessionId: input.acpSessionId,
    runtimeHarness: input.runtimeHarness,
    nativeAgent: input.nativeAgent,
    persistAcpSessionId: async (acpSessionId) => {
      await persistProjectSessionAcpIdentity(input.projectId, input.sessionId, {
        acp_server_id: input.acpServerId as string,
        runtime_harness: input.runtimeHarness as SessionRuntimeHarness,
        acp_session_id: acpSessionId,
      });
    },
  });
}

export function useAcpSessionRuntime(input: {
  projectId: string;
  runtimeUrl: string | null;
  /** Durable Kortix project session id. */
  sessionId: string;
  acpServerId: string | null;
  acpSessionId: string | null;
  runtimeHarness: SessionRuntimeHarness | null;
  /** Immutable harness-native agent or mode selected when the session was created. */
  nativeAgent?: string | null;
  /** Existing ACP sessions without immutable multi-harness metadata. */
  legacySessionId?: string | null;
  enabled: boolean;
}) {
  const controller = useMemo(
    () => createAcpSessionRuntimeController(input),
    [
      input.acpServerId,
      input.acpSessionId,
      input.legacySessionId,
      input.nativeAgent,
      input.projectId,
      input.runtimeHarness,
      input.runtimeUrl,
      input.sessionId,
    ],
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
  const rewind = useCallback(
    (messageId: string) => {
      if (!controller) throw new Error('ACP session runtime is not ready');
      return controller.rewind(messageId);
    },
    [controller],
  );
  const restoreRewind = useCallback(() => {
    if (!controller) throw new Error('ACP session runtime is not ready');
    return controller.restoreRewind();
  }, [controller]);
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
    rewindState: snapshot.rewind,
    send,
    cancel,
    runCommand,
    rewind,
    restoreRewind,
    answerPermission,
    answerQuestion,
    rejectQuestion,
  };
}
