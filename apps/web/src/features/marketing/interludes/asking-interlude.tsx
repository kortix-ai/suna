'use client';

import type { ReactNode } from 'react';
import { asking } from './content';
import { Interlude, Panel } from './interlude';

/**
 * Interlude 1 — sits between the use-case wheel and the self-host slab.
 *
 * WHAT IT FIXES. The wheel above it is entirely OUTPUT: ten finished artifacts,
 * a spreadsheet, a diff, an unsent draft. The page never once shows the INPUT,
 * so a reader watches ten results go past with no idea what a person did to get
 * any of them. That is why the cards land without follow-through. This is the
 * missing half — the sentence somebody typed — and it is also the rest between
 * the pinned wheel and the slab that follows it.
 *
 * WHY THE PANEL IS TEXT, NOT A SCREENSHOT. dosco has real product footage
 * (`public/media/showcase/`), and the hero already uses it. A second video here
 * would be the opposite of a quiet section. What the panel shows instead is the
 * one thing that is honest to render as markup: the words a person types. It
 * deliberately draws no chat window, no send button and no product chrome,
 * because none of that would be a picture of anything real.
 *
 * ONE PROMPT PER MODE, NOT THREE. The point is the difference between the three
 * modes, and a reader gets that from one example each. More would turn the
 * quiet section into a list to work through.
 *
 * Copy, and the accuracy gate every line of it had to pass, live in
 * `content.ts`. Read that file before editing a word here.
 */
function AskPanel(): ReactNode {
  return (
    <Panel title={asking.panel.title} label={asking.panel.label} footer={asking.panel.footer}>
      <ul>
        {asking.modes.map((mode) => (
          <li
            key={mode.id}
            className="border-border/50 border-b px-4 py-5 last:border-b-0 sm:px-5"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-foreground font-mono text-[10px] tracking-widest uppercase">
                {mode.name}
              </span>
              <span className="text-muted-foreground/70 text-[11.5px]">{mode.definition}</span>
            </div>

            <div className="mt-3 flex min-w-0 gap-2.5">
              <span
                aria-hidden
                className="text-muted-foreground/40 shrink-0 font-mono text-[13px] leading-[1.7] select-none"
              >
                ›
              </span>
              <p className="text-foreground min-w-0 text-[13px] leading-[1.7] text-pretty">
                {mode.prompt}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function AskingInterlude(): ReactNode {
  return (
    <Interlude
      id="asking"
      eyebrow={asking.eyebrow}
      title={asking.title}
      paragraphs={asking.paragraphs}
      panel={<AskPanel />}
    />
  );
}
