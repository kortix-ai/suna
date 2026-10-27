'use client';

import { StepComputer } from '@/features/marketing/how-it-work/step/step-computer';
import { StepConnectors } from '@/features/marketing/how-it-work/step/step-connectors';
import { StepModels } from '@/features/marketing/how-it-work/step/step-models';
import { StepSourceOfTruth } from '@/features/marketing/how-it-work/step/step-source-of-truth';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

// Copy follows the accuracy gate in how-it-work/how-it-works-content.ts:
// connector credentials are brokered server-side; a session machine is "its
// own isolated machine", never a microVM.
const TABS: {
  id: string;
  title: string;
  description: string;
  panel: () => ReactNode;
  /** No frame: the panel paints the whole area and may overflow it. */
  bare?: boolean;
}[] = [
  {
    id: 'source',
    title: 'Keep one source of truth',
    description: 'Agents, skills, memory and triggers live in one repo you own.',
    panel: () => <StepSourceOfTruth />,
    bare: true,
  },
  {
    id: 'context',
    title: 'Connect to everything',
    description:
      '3,000+ apps in a click, plus MCP servers and any API over OpenAPI, GraphQL or plain HTTP, your own included. Set it up once and choose which agent may use each.',
    panel: () => <StepConnectors />,
    bare: true,
  },
  {
    id: 'models',
    title: 'Run any model',
    description: 'Pick the model per agent or session, with your key or ours.',
    panel: () => <StepModels />,
    bare: true,
  },
  {
    id: 'computer',
    title: 'Every agent gets its own computer',
    description:
      'A full cloud computer per session: a terminal, your files, code and a browser for anything with no API, from old portals to internal apps. Your team can connect their own computers too, under rules each person sets on the machine.',
    panel: () => <StepComputer />,
    bare: true,
  },
];

/**
 * How it works, after Buio's DeveloperTabs: a two-tone heading and a list of
 * tabs on the left, the selected tab's product panel centred in a plain
 * rectangle on the right, inside a band whose top and bottom hairlines cross
 * the page. The panels are the existing how-it-work step visuals; each
 * plays once when it mounts in view.
 */
export function HowItWorksTabs() {
  const [selected, setSelected] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move along the tablist (WAI-ARIA tabs, automatic activation).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (selected + step + TABS.length) % TABS.length;
    setSelected(next);
    tabRefs.current[next]?.focus();
  };

  const tab = TABS[selected];

  return (
    <section id="how-it-works" className="scroll-mt-16 py-24 lg:py-32">
      {/* Band row: hairlines across the whole page, like the hero band. */}
      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <div className="px-4 py-12 lg:px-11 lg:py-16 lg:pr-12">
            <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
              How Kortix works.
              <span className="text-muted-foreground block">
                One repo, every tool, a computer per agent.
              </span>
            </h2>

            <div
              role="tablist"
              aria-label="How Kortix works"
              aria-orientation="vertical"
              onKeyDown={onKeyDown}
              className="mt-12 flex flex-col gap-8"
            >
              {TABS.map((item, i) => (
                <button
                  key={item.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`how-tab-${item.id}`}
                  aria-controls="how-panel"
                  aria-selected={i === selected}
                  tabIndex={i === selected ? 0 : -1}
                  onClick={() => setSelected(i)}
                  className="outline-ring duration-moderate w-full rounded-sm text-left opacity-50 transition-opacity ease-out hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-4 aria-selected:opacity-100"
                >
                  <h3 className="text-foreground text-base font-medium text-pretty">
                    {item.title}
                  </h3>
                  <p className="text-muted-foreground mt-2 text-sm text-balance">
                    {item.description}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* A plain rectangle; the selected tab's panel sits in its centre.
              Keyed by tab so the panel remounts and plays from the start. */}
          <div
            role="tabpanel"
            id="how-panel"
            aria-labelledby={`how-tab-${tab.id}`}
            className="bg-card flex items-center justify-center border-t p-4 sm:p-8 lg:border-t-0 lg:border-l lg:p-12"
          >
            <div
              key={tab.id}
              className={
                tab.bare
                  ? 'relative flex h-96 w-full min-w-0 flex-col xl:h-112'
                  : 'bg-background flex h-96 w-full min-w-0 flex-col overflow-hidden rounded-lg border xl:h-112'
              }
            >
              {tab.panel()}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
