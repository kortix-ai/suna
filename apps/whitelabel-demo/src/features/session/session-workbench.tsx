'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { errorToast } from '@/components/ui/toast';
import { continueSessionAction } from '@/lib/actions';
import { SessionComposer } from './session-composer';
import { useSessionStream } from './session-stream';
import { Timeline } from './timeline';
import { buildTimeline, type TimelineItem } from './types';

/**
 * The session surface: a clean, single-column streaming chat — sidebar + this
 * transcript + composer — mirroring the core Kortix session. Sending a message
 * really posts to the agent and re-opens the stream so the response streams in.
 */
export function SessionWorkbench({ sessionId, prompt }: { sessionId: string; prompt: string }) {
  const [reconnectKey, setReconnectKey] = useState(0);
  const [optimistic, setOptimistic] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const { state, status } = useSessionStream(sessionId, reconnectKey);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = state?.transcript?.messages;
  const items = useMemo(
    () => buildTimeline({ prompt, messages: messages ?? [] }),
    [prompt, messages],
  );

  // Optimistic user messages, shown until the backend transcript reflects them.
  const optimisticItems: TimelineItem[] = optimistic
    .filter((text) => !items.some((i) => i.kind === 'user' && i.text === text))
    .map((text, i) => ({ id: `optimistic-${i}`, kind: 'user', text }));
  const allItems = [...items, ...optimisticItems];

  const hasError = Boolean(state?.error || state?.session?.error);
  const working = (status === 'connecting' || status === 'live' || sending) && !hasError;
  const onlyInitial = allItems.length <= 1;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [allItems.length, working]);

  const handleSend = async (text: string) => {
    setOptimistic((o) => [...o, text]);
    setSending(true);
    try {
      const result = await continueSessionAction({ sessionId, prompt: text });
      if (result.ok) {
        setReconnectKey((k) => k + 1);
      } else {
        setOptimistic((o) => o.filter((t) => t !== text));
        errorToast(result.error ?? 'Could not send your message.');
      }
    } catch {
      setOptimistic((o) => o.filter((t) => t !== text));
      errorToast('Could not send your message.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto px-4 pt-6">
        {hasError ? (
          <div className="mx-auto mb-4 max-w-3xl">
            <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
              {state?.error ?? state?.session?.error}
            </div>
          </div>
        ) : null}

        <Timeline items={allItems} working={working} />

        {onlyInitial && working ? (
          <p className="text-muted-foreground mx-auto mt-4 max-w-3xl text-center text-xs">
            Connecting to the workspace…
          </p>
        ) : null}

        <div ref={bottomRef} className="h-2" />
        <SessionComposer onSend={handleSend} sending={sending} />
      </div>
    </div>
  );
}
