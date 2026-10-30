'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useRef } from 'react';

import { ChatMinimap } from '@kortix/ui/session';
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  sessionLogTurns,
  type SessionLogBlock,
  type SessionLogMessage,
} from '@kortix/sdk';

/**
 * /debug/minimap
 *
 * Companion to /debug/turn. That page inspects the assembled turn; this one
 * inspects the jump rail that sits beside it.
 *
 * Exists because everything the rail is judged on is invisible to unit tests:
 * the width taper across neighbouring dashes, whether the preview card glides
 * or jumps between messages, whether a mention chip sits on the text baseline,
 * and light/dark contrast on a 3px dash. Driving a real session needs a
 * provisioned sandbox; this needs nothing. Not linked from anywhere — just hit
 * /debug/minimap.
 */

let n = 0;
const nextId = () => `prt_dbg_${(n += 1)}`;

function text(value: string): SessionLogBlock {
  return { type: 'text', id: nextId(), text: value };
}

function file(filename: string): SessionLogBlock {
  return { type: 'attachment', id: nextId(), mime: 'text/plain', name: filename };
}

function turn(id: string, blocks: SessionLogBlock[]): SessionLogMessage {
  return {
    schema: SESSION_LOG_SCHEMA,
    v: SESSION_LOG_MINOR,
    message_id: id,
    thread_id: 'ses_dbg',
    seq: 0,
    role: 'user',
    kind: 'turn',
    status: 'complete',
    in_context: true,
    model: null,
    usage: null,
    finish: null,
    error: null,
    created_at: '',
    completed_at: null,
    producer: { harness: 'debug', harness_version: '', adapter_version: '' },
    blocks,
  };
}

/** Shapes drawn from real transcripts: mentions, attachments, and plain asks. */
const PROMPTS: SessionLogMessage[] = [
  turn('u1', [
    text(
      '@Gpt Taste @Make Interfaces Feel Better\nReady for review.\nLinear project: Kortix Marketing Update\n<agent_ref name="Gpt Taste" />\n<agent_ref name="Make Interfaces Feel Better" />\n<file_ref path="data/content-timestamps.json" name="content-timestamps.json" />',
    ),
  ]),
  turn('u2', [text('no bro u need to make the Kortix marketing update land this week, not next')]),
  turn('u3', [
    text(
      'GO ahead and build it plz plan approved @Marketing Agent\n<agent_ref name="Marketing Agent" />',
    ),
  ]),
  turn('u4', [
    text('you can stop now the qa and just stop i will further review it myself tomorrow'),
    file('landing-quality.test.ts'),
    file('hero.tsx'),
    file('pricing.tsx'),
    file('nav.tsx'),
    file('footer.tsx'),
  ]),
  turn('u5', [text('what changed in the pricing page since the last deploy?')]),
  turn('u6', [file('screenshot-2026-08-01.png')]),
  turn('u7', [
    text(
      'this is a much longer message that should clamp to three lines inside the preview card, because a prompt written in one breath can easily run past what any card ought to show, and the clamp is the only thing keeping every card the same shape as the rail glides between them',
    ),
  ]),
  turn('u8', [text('ship it')]),
];

/** The prompts as the session-log turns `ChatMinimap` reads. */
const LOG_TURNS = sessionLogTurns({
  schema: SESSION_LOG_SCHEMA,
  v: SESSION_LOG_MINOR,
  thread_id: 'ses_dbg',
  parent_thread_id: null,
  spawned_by: null,
  agent: null,
  title: null,
  created_at: '',
  messages: PROMPTS,
});

export default function DebugMinimapPage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div className="bg-background flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('text52e30cc313a7')}
        </h1>
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text127337c48cdc')}</p>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          <div ref={contentRef} className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
            {LOG_TURNS.map((t) => (
              <div
                key={t.id}
                data-turn-id={t.id}
                className="flex h-64 shrink-0 items-center justify-end"
              >
                <div className="bg-sidebar text-foreground max-w-[80%] rounded-lg px-3 py-2.5 text-sm">
                  {t.id}
                </div>
              </div>
            ))}
          </div>
        </div>

        <ChatMinimap
          turns={LOG_TURNS}
          scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
          contentRef={contentRef as React.RefObject<HTMLDivElement>}
        />
      </div>
    </div>
  );
}
