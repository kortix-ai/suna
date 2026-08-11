'use client';

import { useRef } from 'react';

import { ChatMinimap } from '@/features/session/chat-minimap';
import type { Part, Turn } from '@/ui';

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

function text(value: string): Part {
  return { id: nextId(), messageID: 'msg_dbg', sessionID: 'ses_dbg', type: 'text', text: value } as unknown as Part;
}

function file(filename: string): Part {
  return {
    id: nextId(),
    messageID: 'msg_dbg',
    sessionID: 'ses_dbg',
    type: 'file',
    mime: 'text/plain',
    filename,
    url: '',
  } as unknown as Part;
}

function turn(id: string, parts: Part[]): Turn {
  return {
    userMessage: { info: { id, role: 'user' }, parts },
    assistantMessages: [],
  } as unknown as Turn;
}

/** Shapes drawn from real transcripts: mentions, attachments, and plain asks. */
const TURNS: Turn[] = [
  turn('u1', [
    text(
      '@Gpt Taste @Make Interfaces Feel Better\nReady for review.\nLinear workspace: Kortix Marketing Update\n<agent_ref name="Gpt Taste" />\n<agent_ref name="Make Interfaces Feel Better" />\n<file_ref path="data/content-timestamps.json" name="content-timestamps.json" />',
    ),
  ]),
  turn('u2', [text('no bro u need to make the Kortix marketing update land this week, not next')]),
  turn('u3', [
    text('GO ahead and build it plz plan approved @Marketing Agent\n<agent_ref name="Marketing Agent" />'),
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

export default function DebugMinimapPage() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div className="bg-background flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-foreground text-sm font-medium">/debug/minimap</h1>
        <p className="text-muted-foreground text-xs">
          Hover the rail on the left. The dash taper follows the pointer; the card glides.
        </p>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          <div ref={contentRef} className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
            {TURNS.map((t) => (
              <div
                key={t.userMessage.info.id}
                data-turn-id={t.userMessage.info.id}
                className="flex h-64 shrink-0 items-center justify-end"
              >
                <div className="bg-sidebar text-foreground max-w-[80%] rounded-lg px-3 py-2.5 text-sm">
                  {t.userMessage.info.id}
                </div>
              </div>
            ))}
          </div>
        </div>

        <ChatMinimap
          turns={TURNS}
          scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
          contentRef={contentRef as React.RefObject<HTMLDivElement>}
        />
      </div>
    </div>
  );
}
