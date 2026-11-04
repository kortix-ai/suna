/**
 * The open session's outputs, live (`session-outputs.ts` holds the rules).
 *
 * The thread half updates with every streamed block. The published half is
 * `useArtifacts` (flag `artifacts`): it is read again whenever the thread
 * gains a block or a message settles, because `kortix artifacts publish` runs
 * as a tool call and its artifact exists once that call returns. Nothing
 * polls on a clock.
 */

import type { SessionLogMessage } from '@kortix/sdk';
import { useArtifacts, useFeatureFlag } from '@kortix/sdk/react';
import { useEffect, useMemo } from 'react';

import { type SessionOutput, sessionOutputs } from './session-outputs.ts';

const NO_ARTIFACTS: never[] = [];

/** Changes when a block lands or a message settles: when a new output can exist. */
export function threadSignature(messages: readonly SessionLogMessage[]): string {
  const last = messages[messages.length - 1];
  return last ? `${messages.length}:${last.message_id}:${last.blocks.length}:${last.status}` : '0';
}

export function useSessionOutputs(input: {
  projectId: string;
  sessionId: string;
  messages: readonly SessionLogMessage[];
  webBaseUrl: string;
}): SessionOutput[] {
  const { projectId, sessionId, messages, webBaseUrl } = input;
  const flag = useFeatureFlag(projectId, 'artifacts');
  const list = useArtifacts(flag.enabled ? projectId : null);
  const refetch = list.refetch;
  const signature = threadSignature(messages);

  // biome-ignore lint/correctness/useExhaustiveDependencies(signature): the thread's shape is the trigger.
  useEffect(() => {
    if (flag.enabled) void refetch().catch(() => {});
  }, [signature, flag.enabled, refetch]);

  const artifacts = list.data ?? NO_ARTIFACTS;
  return useMemo(
    () => sessionOutputs({ messages, artifacts, sessionId, projectId, webBaseUrl }),
    [messages, artifacts, sessionId, projectId, webBaseUrl],
  );
}
