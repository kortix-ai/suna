'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { INFRA } from '@/features/marketing/v2/content';
import { Frame, Heading, Lead, Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';

const ORBIT = [
  { name: 'GitHub', node: Icon.Github },
  { name: 'Slack', node: Icon.Slack },
  { name: 'Linear', node: Icon.Linear },
  { name: 'Notion', node: Icon.Notion },
  { name: 'Microsoft Teams', node: Icon.MicrosoftTeams },
  { name: 'Gmail', node: Icon.Gmail },
];

export function InfrastructureSection() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setActive((i) => (i + 1) % INFRA.steps.length), 4200);
    return () => clearInterval(id);
  }, []);

  return (
    <Section id="infrastructure">
      <div className="mx-auto max-w-2xl text-center">
        <Heading lines={INFRA.heading} />
        <Lead className="mt-5">{INFRA.subheading}</Lead>
      </div>

      <div className="mt-14 grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <ol className="order-2 lg:order-1">
          {INFRA.steps.map((step, i) => {
            const isActive = i === active;
            return (
              <li key={step.name}>
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn(
                    'w-full cursor-pointer border-l-2 py-4 pl-5 text-left transition-colors',
                    isActive ? 'border-kortix-blue' : 'border-border hover:border-foreground/30',
                  )}
                >
                  <p
                    className={cn(
                      'text-base font-medium transition-colors',
                      isActive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {step.name}
                  </p>
                  {isActive && (
                    <p className="text-muted-foreground mt-2 max-w-sm text-[0.9375rem] leading-relaxed">
                      {step.description}
                    </p>
                  )}
                </button>
              </li>
            );
          })}
        </ol>

        <Frame className="order-1 aspect-[4/3] lg:order-2">
          <Orbit />
        </Frame>
      </div>
    </Section>
  );
}

function Orbit() {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      aria-hidden
      data-a11y-decorative
    >
      <div className="relative aspect-square w-[62%]">
        <div className="border-border absolute inset-0 rounded-full border border-dashed" />

        <div className="border-border bg-background absolute top-1/2 left-1/2 flex size-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm border shadow-sm">
          <KortixLogo size={30} variant="symbol" />
        </div>

        {ORBIT.map((item, i) => {
          const angle = (i / ORBIT.length) * Math.PI * 2 - Math.PI / 2;
          return (
            <div
              key={item.name}
              className="border-border bg-background absolute flex size-14 items-center justify-center rounded-full border shadow-xs"
              style={{
                left: `calc(50% + ${Math.cos(angle) * 50}%)`,
                top: `calc(50% + ${Math.sin(angle) * 50}%)`,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <item.node className="size-6" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
