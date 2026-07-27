'use client';

/**
 * Side-panel "Voice" view — the live (or past) voice-call transcript for this
 * session: both sides of the spoken conversation PLUS every ask_kortix/
 * run_command the voice-agent worker issued through the voice MCP, in one
 * chronological feed. See `session-voice-transcript-shared.ts`'s header for
 * why this is a poll-and-replace read rather than a cursor-accumulating one.
 *
 * Connector/tool calls the agent makes during the session (spawning this
 * call, or anything else) already surface in the "Audit" tab
 * (`session-audit-panel.tsx`) — every executor-gated action is recorded in
 * `executor_executions` regardless of connector, voice included. This panel
 * is specifically the call's own transcript, which lives in a separate table
 * (`voice_call_turns`) because it is a running conversation, not a discrete
 * action log.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  relativeTurnTime,
  turnSpeakerLabel,
  useVoiceTranscript,
} from '@/features/session/session-voice-transcript-shared';
import { cn } from '@/lib/utils';
import type { VoiceTranscriptTurn } from '@kortix/sdk';
import { Phone, PhoneOff, Terminal } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function SessionVoiceTranscriptPanel({
  projectId,
  projectSessionId,
}: {
  projectId?: string;
  projectSessionId?: string;
}) {
  const { data, isLoading, isError, refetch } = useVoiceTranscript(projectId, projectSessionId);
  const turns = data?.turns ?? [];
  const live = data?.live ?? false;

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Stick to the bottom as new turns arrive (a conversation reads newest-at-
  // bottom) unless the caller has scrolled up to read back — same
  // "don't yank the reader" rule as chat.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border/60 px-6 py-3">
        <div>
          <h2 className="text-foreground text-sm font-semibold tracking-tight">Voice</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            The live call transcript — what was said, and what the agent did.
          </p>
        </div>
        {live && (
          <Badge variant="success" size="xs" className="gap-1">
            <span className="bg-kortix-green size-1.5 shrink-0 animate-pulse rounded-full" />
            Live
          </Badge>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loading className="animate-spin" />
          </div>
        ) : isError ? (
          <div className="px-6 py-16">
            <ErrorState
              size="sm"
              title="Couldn't load the voice transcript"
              action={
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  Retry
                </Button>
              }
            />
          </div>
        ) : turns.length === 0 ? (
          <div className="px-6 py-16">
            <EmptyState
              size="sm"
              icon={Phone}
              title="No voice call in this session yet"
              description="When the agent starts or joins a call, every spoken turn and every ask_kortix / run_command it issues shows up here as it happens."
            />
          </div>
        ) : (
          <ul className="space-y-2 px-4 py-3">
            {turns.map((turn) => (
              <TranscriptRow key={turn.cursor} turn={turn} />
            ))}
            {!live && (
              <li className="flex items-center justify-center gap-1.5 py-3 text-xs text-muted-foreground">
                <PhoneOff className="size-3.5 shrink-0" />
                Call ended
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function TranscriptRow({ turn }: { turn: VoiceTranscriptTurn }) {
  const isTool = turn.role === 'tool';
  const isAgent = turn.role === 'agent';

  if (isTool) {
    return (
      <li className="bg-popover/60 flex items-start gap-2 rounded-md border border-dashed px-3 py-2">
        <Terminal className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground truncate font-mono text-xs" title={turn.text}>
            {turn.text}
          </p>
        </div>
        <span className="text-muted-foreground/70 shrink-0 text-[11px]">
          {relativeTurnTime(turn.at)}
        </span>
      </li>
    );
  }

  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-md border px-4 py-2',
        isAgent ? 'bg-primary/[0.04]' : 'bg-popover',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground text-xs font-medium">
            {turnSpeakerLabel(turn.role, turn.speaker)}
          </span>
          <span className="text-muted-foreground/70 text-[11px]">{relativeTurnTime(turn.at)}</span>
        </div>
        <p className="text-foreground mt-0.5 text-sm text-pretty">{turn.text}</p>
      </div>
    </li>
  );
}
