'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/features/layout/section/empty-state';
import Hint from '@/components/ui/hint';
import { IconAgent, IconMessage, IconTerminal } from '@/components/ui/kortix-icons';
import { StatusDot } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { useEffect, useMemo, useRef } from 'react';

import { buildFeed, elapsedLabel, outcomeTone, type FeedRow } from './feed';
import type { CallRecordEntry, LiveUtterance } from './types';

/** Only auto-scroll if the reader was already near the bottom — never yank
 *  someone who scrolled up to re-read something the agent said earlier. */
const NEAR_BOTTOM_PX = 96;

/** The tool whose two stored rows are folded into one (see `feed.ts`), and the
 *  only one that is a hand-off to another model rather than a command. */
const ASK_TOOL = 'ask_kortix';

/**
 * The centerpiece of the room: the WHOLE call, not just the two voices.
 *
 * It used to render LiveKit's client-side transcription and nothing else,
 * which is why the page showed a conversation with holes in it. Everything the
 * Kortix agent put into the call, and every tool call the voice made, is
 * written server-side to `voice_call_turns` and never appears in the browser's
 * LiveKit stream at all — so it was simply absent. `entries` is that durable
 * record; `live` is the LiveKit tail, kept only for the seconds between
 * someone speaking and the server writing it down.
 *
 * FOUR THINGS HAPPEN ON A CALL AND ALL FOUR MUST BE TELLABLE APART (see
 * `CallEntryKind`) — because a voice call, alone among the channels, has TWO
 * models on it: the voice on the line, and the Kortix agent it hands work to.
 *
 *   the human         right-hand bubble, tinted with the primary
 *   the voice         left-hand bubble, plain popover surface
 *   the Kortix agent  left-hand bubble, kortix-tinted, agent glyph, and a hint
 *                     saying it was sent INTO the call — the voice line right
 *                     after it is a paraphrase of it, not a repeat of it
 *   a tool call       not a bubble at all: full width, dashed, a status tile
 *                     and the outcome as a badge. Nobody spoke it.
 *
 * The name is printed ONCE per run of consecutive lines by the same speaker
 * rather than on every bubble, and each line's time is present without
 * shouting: on the run's label, and on hover for every line inside it. Both of
 * those decisions are made in `buildFeed`, not here.
 */
export function TranscriptFeed({
  entries,
  live,
  className,
}: {
  entries: CallRecordEntry[];
  live: LiveUtterance[];
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);

  const rows = useMemo(() => buildFeed(entries), [entries]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !wasNearBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [entries, live]);

  const isEmpty = entries.length === 0 && live.length === 0;

  return (
    <Card className={cn('flex min-h-0 flex-col', className)}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          Transcript
          <StatusDot tone="success" pulse />
        </CardTitle>
      </CardHeader>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          wasNearBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {isEmpty ? (
          <div className="flex h-full min-h-40 items-center justify-center">
            <EmptyState
              size="sm"
              icon={IconMessage}
              title="Waiting for the conversation to start"
              description="Everything on this call shows up here — what's said on either side, what your Kortix agent sends in, and the tools it runs."
            />
          </div>
        ) : (
          <CardContent className="space-y-3 p-0">
            {rows.map((row) =>
              row.entry.kind === 'tool' ? (
                <ToolRow key={row.key} row={row} />
              ) : (
                <SpeechRow
                  key={row.key}
                  name={row.entry.name}
                  text={row.entry.text}
                  at={row.entry.at}
                  showLabel={row.showLabel}
                  side={row.entry.kind === 'human' ? 'right' : 'left'}
                  tone={row.entry.kind}
                />
              ),
            )}
            {live.length > 0 && <LiveTail live={live} />}
          </CardContent>
        )}
      </div>
    </Card>
  );
}

/**
 * The tail: said out loud, not written down yet.
 *
 * It used to be an unlabelled italic bubble hanging off the bottom of the
 * feed, which reads as something being broken. It is the opposite — it is the
 * page being FASTER than the record — so the group says so out loud. Each line
 * retires itself the moment the durable record catches up with it
 * (`unrecordedLive`), which is why this can never be a second copy of the
 * conversation.
 */
function LiveTail({ live }: { live: LiveUtterance[] }) {
  return (
    <>
      <div className="flex items-center gap-2 pt-1">
        <span className="bg-border h-px flex-1" aria-hidden />
        <span className="text-muted-foreground/70 text-xs">
          Live — not written to the transcript yet
        </span>
        <span className="bg-border h-px flex-1" aria-hidden />
      </div>
      {live.map((utterance, i) => (
        <SpeechRow
          key={utterance.id}
          name={utterance.name}
          text={utterance.text}
          at={null}
          // The same run rule as the record, applied inside the tail: one name
          // per stretch of the same voice, not one per fragment.
          showLabel={live[i - 1]?.name !== utterance.name}
          side={utterance.isLocal ? 'right' : 'left'}
          tone={utterance.isLocal ? 'human' : 'voice'}
          pending={!utterance.final}
        />
      ))}
    </>
  );
}

/** Bubble treatment per speaking kind. `kortix` gets its own so the agent's
 *  own words are never mistaken for the voice's — they are two actors, and the
 *  voice's line right after is a paraphrase of the agent's, not a repeat. */
const BUBBLE_TONE: Record<'human' | 'voice' | 'kortix', string> = {
  human: 'bg-primary/[0.06] border-primary/10',
  voice: 'bg-popover border-border',
  kortix: 'bg-kortix-base/10 border-kortix-base/30',
};

/** `HH:MM` in the reader's own locale, or null for a stamp we cannot read.
 *  Safe to localize: nothing here is server-rendered — the record arrives from
 *  a poll in the browser, so there is no markup for a locale to disagree with. */
function clockTime(at: string): string | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fullTime(at: string): string | undefined {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
}

/** Small, muted, tabular — a column of these must not jitter as it updates. */
function Timestamp({ at, className }: { at: string; className?: string }) {
  const clock = clockTime(at);
  if (!clock) return null;
  return (
    <time
      dateTime={at}
      title={fullTime(at)}
      className={cn('text-muted-foreground/60 shrink-0 text-xs tabular-nums', className)}
    >
      {clock}
    </time>
  );
}

function SpeechRow({
  name,
  text,
  at,
  side,
  tone,
  showLabel,
  pending = false,
}: {
  name: string;
  text: string;
  /** Null for the live tail — it is not in the record, so it has no recorded
   *  time to show, and inventing one from the browser clock would be a lie. */
  at: string | null;
  side: 'left' | 'right';
  tone: 'human' | 'voice' | 'kortix';
  showLabel: boolean;
  pending?: boolean;
}) {
  const label = (
    <span className="text-muted-foreground flex items-center gap-1 text-xs font-medium">
      {tone === 'kortix' && <IconAgent className="size-3 shrink-0" aria-hidden />}
      {name}
    </span>
  );

  return (
    <div className={cn('group flex flex-col gap-1', side === 'right' ? 'items-end' : 'items-start')}>
      {showLabel && (
        <div className="flex items-center gap-1.5 px-1">
          {tone === 'kortix' ? (
            <Hint
              side="top"
              label="Sent into the call by your Kortix agent — the voice relays it in its own words"
            >
              {label}
            </Hint>
          ) : (
            label
          )}
          {at && <Timestamp at={at} />}
        </div>
      )}
      <div
        className={cn(
          'flex max-w-[85%] items-end gap-2',
          side === 'right' ? 'flex-row-reverse' : 'flex-row',
        )}
      >
        <div
          className={cn(
            'min-w-0 rounded-md border px-3 py-2 text-sm text-pretty',
            BUBBLE_TONE[tone],
            pending && 'text-muted-foreground italic',
          )}
        >
          {text || '…'}
          {pending && (
            <span
              aria-hidden
              className="bg-current ml-1 inline-block size-1.5 animate-pulse rounded-full align-middle"
            />
          )}
        </div>
        {/* Every line has a time; only the first of a run wears it. The rest
            surface on hover, so the time is always reachable without running a
            column of numbers down the side of the conversation. */}
        {at && !showLabel && (
          <Timestamp at={at} className="opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>
    </div>
  );
}

/**
 * A tool call — an MCP call the voice made (`ask_kortix`, `run_command`).
 *
 * Deliberately NOT a bubble and deliberately not attributed to anyone: nobody
 * said this. Full width, dashed, a tinted status tile, the tool's REAL name
 * (not a friendlier invention — this is the record of what ran), its argument
 * in monospace, and how it turned out as a badge.
 *
 * A hand-off shows as ONE row for its whole life: `waiting` while Kortix works,
 * then the outcome when the settle row lands — see `foldAskSettlements`, which
 * is where the two stored rows become one.
 */
function ToolRow({ row }: { row: FeedRow }) {
  const { entry, pending, settledAt } = row;
  const tone = pending ? 'pending' : entry.outcome ? outcomeTone(entry.outcome) : 'neutral';
  const Glyph = entry.name === ASK_TOOL ? IconAgent : IconTerminal;
  // How long the hand-off ran, for the reader wondering why the call went quiet.
  const took = settledAt ? elapsedLabel(entry.at, settledAt) : null;

  return (
    <div className="bg-muted/40 border-border/60 flex w-full items-start gap-3 rounded-md border border-dashed px-3 py-2">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-sm',
          tone === 'ok' && 'bg-kortix-green/15',
          tone === 'bad' && 'bg-kortix-red/15',
          tone === 'pending' && 'bg-kortix-yellow/15',
          tone === 'neutral' && 'bg-foreground/5',
        )}
      >
        <Glyph
          aria-hidden
          className={cn(
            'size-4',
            tone === 'ok' && 'text-kortix-green',
            tone === 'bad' && 'text-kortix-red',
            tone === 'pending' && 'text-kortix-yellow',
            tone === 'neutral' && 'text-muted-foreground',
          )}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate font-mono text-xs font-medium">
            {entry.name}
          </span>
          {pending ? (
            <Badge variant="muted" size="xs" className="animate-pulse">
              waiting
            </Badge>
          ) : entry.outcome ? (
            <Badge
              variant={tone === 'ok' ? 'success' : tone === 'bad' ? 'destructive' : 'muted'}
              size="xs"
            >
              {entry.outcome}
            </Badge>
          ) : null}
          {took && (
            <span className="text-muted-foreground/60 text-xs tabular-nums">{took}</span>
          )}
          <Timestamp at={entry.at} className="ml-auto" />
        </div>
        {entry.text && (
          <div className="text-muted-foreground mt-0.5 font-mono text-xs wrap-break-word">
            {entry.text}
          </div>
        )}
      </div>
    </div>
  );
}
