'use client';

import { useTranslations } from '@/i18n/use-translations';

import { useRef, useState, type KeyboardEvent } from 'react';

import { LAYER_PANELS } from './layer-panels';
import { localizeMarketingContent as localizeModel } from './model';

/**
 * One tab per layer of the model, in the home page's HowItWorksTabs shape:
 * the heading and the tabs on the left, the selected layer on the right as
 * two short sentences over one visual. One layer at a time, never all.
 */
export function LayerTabs() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { layers } = localizeModel(tMarketing);

  const [selected, setSelected] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs = layers.tabs;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (selected + step + tabs.length) % tabs.length;
    setSelected(next);
    tabRefs.current[next]?.focus();
  };

  const tab = tabs[selected];

  const Panel = LAYER_PANELS[tab.id];
  return (
    <section id="how-it-works" className="scroll-mt-16 py-14 lg:py-20">
      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <div className="px-4 py-12 lg:px-11 lg:py-16 lg:pr-12">
            <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
              {layers.title}
              <span className="text-muted-foreground block">{layers.titleMuted}</span>
            </h2>

            <div
              role="tablist"
              aria-label={tMarketing('text6fcd4c9752b5')}
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
                  id={`layer-tab-${item.id}`}
                  aria-controls="layer-panel"
                  aria-selected={i === selected}
                  tabIndex={i === selected ? 0 : -1}
                  onClick={() => setSelected(i)}
                  className="outline-ring duration-moderate w-full rounded-sm text-left opacity-50 transition-opacity ease-out hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-4 aria-selected:opacity-100"
                >
                  <h3 className="text-foreground text-base font-medium text-pretty">
                    {item.title}
                  </h3>
                  <p className="text-muted-foreground mt-1 text-sm text-balance">
                    {item.description}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div
            role="tabpanel"
            id="layer-panel"
            aria-labelledby={`layer-tab-${tab.id}`}
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
                    {line}
                  </p>
                ))}
              </div>
              {Panel ? <Panel /> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
