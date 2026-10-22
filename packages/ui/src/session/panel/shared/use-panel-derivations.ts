import { useLayoutEffect, useMemo, useRef } from 'react';
import { useSessionLogThread } from '@kortix/sdk/react';
import { samePartsList } from '../../turn/same-parts';
import { deriveIsRunning } from '../easy/easy-panel-logic';
import { collectAllToolCalls } from './collect-tool-parts';
import { deriveContext, deriveOutputs } from './derive-panels';
import { groupSteps } from '@kortix/sdk';
import { latestRunMessages } from './latest-run';
import { sortOutputs } from './output-priority';
import { deriveRunOutcome } from './run-outcome';

/** The previous list while its elements are unchanged, so memos keyed on it hold across a text delta. */
function useSameList<T>(next: T[]): T[] {
  const ref = useRef(next);
  const list = samePartsList(ref.current, next) ? ref.current : next;
  useLayoutEffect(() => {
    ref.current = list;
  });
  return list;
}

export function usePanelDerivations({ sessionId, projectId, projectSessionId, isSessionBusy }: {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
  isSessionBusy: boolean;
}) {
  // The root thread's messages: the `fromV1` live view of the v1 rows while
  // v2 is off, the API's session log on v2. Tool calls and message info only:
  // a streamed text delta replaces its message, never the message's tool-call
  // blocks, so the call lists below keep their identity (`useSameList`), every
  // memo on them holds, and nothing under the provider re-renders per delta.
  const thread = useSessionLogThread({
    projectId: projectId ?? '',
    sessionId: projectSessionId ?? '',
    runtimeSessionId: sessionId,
  });
  const messages = thread?.messages;
  const calls = useSameList(useMemo(() => collectAllToolCalls(messages), [messages]));
  const steps = useMemo(() => groupSteps(calls), [calls]);
  const latestCalls = useSameList(
    useMemo(() => collectAllToolCalls(latestRunMessages(messages)), [messages]),
  );
  const latestIds = useMemo(() => new Set(latestCalls.map((c) => c.call_id)), [latestCalls]);
  const outputs = useMemo(() => deriveOutputs(calls, { latestRun: latestIds }), [calls, latestIds]);
  const context = useMemo(() => deriveContext(calls), [calls]);

  // The latest run's own steps, not the session's — read by `outcome` below (a
  // text-only turn must never inherit a verdict from an old errored run
  // further back in the session).
  const latestSteps = useMemo(() => groupSteps(latestCalls), [latestCalls]);

  // A running app is not "one of" the outputs — it's the thing the user asked
  // for, and a list flattens it into row 13 of 13 under a dozen .tsx files they
  // never wanted. It gets its own card; Outputs keeps the files.
  const apps = useMemo(() => outputs.filter((o) => o.kind === 'app'), [outputs]);
  // Sorted, not filtered: everything the agent produced is still here, but the
  // report leads and the twelve files it took to build the report follow. See
  // `sortOutputs` — chronological order buries the answer under its scaffolding.
  //
  // Fresh-first inside the human ranking: the latest run's deliverables lead,
  // then everything the session has ever produced, each group in sortOutputs
  // order. A returning user sees what's new without losing what's old.
  const files = useMemo(() => {
    const nonApps = outputs.filter((o) => o.kind !== 'app');
    return [
      ...sortOutputs(nonApps.filter((o) => o.fresh)),
      ...sortOutputs(nonApps.filter((o) => !o.fresh)),
    ];
  }, [outputs]);

  // Part-derived alone flickers between tool calls (assistant text streams
  // with no part running/pending) — OR it with the session's own status so
  // Outputs only auto-expands at the real finish. See `deriveIsRunning`.
  const isRunning = deriveIsRunning(
    steps.some((s) => s.status === 'running'),
    isSessionBusy,
  );

  const outcome = useMemo(
    () => deriveRunOutcome(messages, latestSteps[latestSteps.length - 1]?.status),
    [messages, latestSteps],
  );

  return { steps, outputs, context, apps, files, isRunning, outcome };
}
