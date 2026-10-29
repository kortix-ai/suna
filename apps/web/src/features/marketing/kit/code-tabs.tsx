'use client';

import { CodePanel } from '@/features/marketing/code-panel';
import { useId, useRef, useState, type KeyboardEvent } from 'react';

export type CodeTab = {
  readonly id: string;
  readonly k: string;
  readonly v: string;
  readonly panel: {
    readonly title: string;
    readonly lines: readonly string[];
    readonly lang: 'yaml' | 'sh';
    /** [start, end) lines to keep bright; the rest of the file dims. */
    readonly focus?: readonly [number, number];
  };
};

/**
 * Notes and code in one band (after Buio's DeveloperTabs): the notes on the
 * left as tabs, the code the selected note is about on the right. Sits inside
 * a `Band`.
 */
export function CodeTabs({ label, tabs }: { label: string; tabs: readonly CodeTab[] }) {
  const [selected, setSelected] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();
  const tab = tabs[selected];

  // Arrow keys move along the tablist (WAI-ARIA tabs, automatic activation).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (selected + step + tabs.length) % tabs.length;
    setSelected(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2">
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-8 px-4 py-12 lg:px-11 lg:py-16 lg:pr-12"
      >
        {tabs.map((item, i) => (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${item.id}`}
            aria-controls={`${base}-panel`}
            aria-selected={i === selected}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => setSelected(i)}
            className="outline-ring w-full rounded-sm text-left opacity-50 transition-opacity duration-moderate ease-out hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-4 aria-selected:opacity-100"
          >
            <h3 className="text-foreground text-base font-medium text-pretty first-letter:uppercase">{item.k}</h3>
            <p className="text-muted-foreground mt-2 text-sm text-pretty">{item.v}</p>
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${tab.id}`}
        className="bg-background flex min-w-0 items-center border-t p-4 sm:p-8 lg:border-t-0 lg:border-l lg:p-12"
      >
        <CodePanel
          title={tab.panel.title}
          lines={tab.panel.lines}
          lang={tab.panel.lang}
          focus={tab.panel.focus}
          className="w-full"
        />
      </div>
    </div>
  );
}
