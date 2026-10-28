'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { HowTab } from './content';
import { InlineCode } from './inline-code';

/**
 * "How it works" for a surface page, in the home page's HowItWorksTabs shape
 * (the same as /security's LayerTabs): the heading and the tabs on the left,
 * the selected tab on the right as two short sentences over one visual.
 * Panels arrive rendered from the server, one per tab.
 */
export function SurfaceTabs({
  title,
  titleMuted,
  tabs,
  panels,
}: {
  title: string;
  titleMuted: string;
  tabs: readonly HowTab[];
  panels: readonly ReactNode[];
}) {
  const [selected, setSelected] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (selected + step + tabs.length) % tabs.length;
    setSelected(next);
    tabRefs.current[next]?.focus();
  };

  const tab = tabs[selected];

  return (
    <section id="how-it-works" className="scroll-mt-16 py-14 lg:py-20">
      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <div className="px-4 py-12 lg:px-11 lg:py-16 lg:pr-12">
            <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
              {title}
              <span className="text-muted-foreground block">{titleMuted}</span>
            </h2>

            <div
              role="tablist"
              aria-label={title}
              aria-orientation="vertical"
              onKeyDown={onKeyDown}
              className="mt-10 flex flex-col gap-6"
            >
              {tabs.map((item, i) => (
                <button
                  key={item.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`surface-tab-${item.id}`}
                  aria-controls="surface-panel"
                  aria-selected={i === selected}
                  tabIndex={i === selected ? 0 : -1}
                  onClick={() => setSelected(i)}
                  className="outline-ring duration-moderate w-full rounded-sm text-left opacity-50 transition-opacity ease-out hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-4 aria-selected:opacity-100"
                >
                  <h3 className="text-foreground text-base font-medium text-pretty">{item.title}</h3>
                  <p className="text-muted-foreground mt-1 text-sm text-balance">
                    <InlineCode text={item.description} />
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div
            role="tabpanel"
            id="surface-panel"
            aria-labelledby={`surface-tab-${tab.id}`}
            className="bg-card flex items-center justify-center border-t p-6 sm:p-8 lg:border-t-0 lg:border-l lg:p-12"
          >
            <div
              key={tab.id}
              className="animate-in fade-in duration-slower flex w-full max-w-xl min-w-0 flex-col gap-8 ease-out"
            >
              <div className="flex flex-col gap-3">
                <h3 className="text-foreground text-xl font-medium tracking-tight">{tab.title}</h3>
                {tab.body.map((line) => (
                  <p key={line} className="text-muted-foreground text-base text-pretty">
                    <InlineCode text={line} />
                  </p>
                ))}
              </div>
              {panels[selected]}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
