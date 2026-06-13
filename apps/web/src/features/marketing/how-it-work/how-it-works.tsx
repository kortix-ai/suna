'use client';

import { Card } from '@/components/ui/card';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { cn } from '@/lib/utils';
import { useInView } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { STEPS, type Step } from './how-it-works-content';
import { Step1ProjectCli } from './step/step-1-project-cli';
import { Step2ConnectCli } from './step/step-2-connect-cli';
import { Step3BuildCli } from './step/step-3-build-cli';
import { Step4ShipCli } from './step/step-4-ship-cli';
import { Step5RunCli } from './step/step-5-run-cli';
import { Step6OwnCli } from './step/step-6-own-cli';

function StepShowcaseFor({ step }: { step: Step }) {
  switch (step.id) {
    case 'create':
      return <Step1ProjectCli />;
    case 'build':
      return <Step3BuildCli />;
    case 'connect':
      return <Step2ConnectCli />;
    case 'ship':
      return <Step4ShipCli />;
    case 'run':
      return <Step5RunCli />;
    case 'own':
      return <Step6OwnCli />;
    default:
      return <StepShowcase step={step} />;
  }
}

function StepShowcase({ step }: { step: Step }) {
  return (
    <div className="relative aspect-video w-full">
      <Card className="flex h-full w-full items-center justify-center border">
        <p className="text-muted-foreground text-sm font-medium">{step.label}</p>
      </Card>
    </div>
  );
}

function StepRow({
  index,
  step,
  onActive,
}: {
  index: number;
  step: Step;
  onActive: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { margin: '-45% 0px -45% 0px' });

  useEffect(() => {
    if (isInView) onActive(index);
  }, [index, isInView, onActive]);

  return (
    <div
      ref={ref}
      className="flex min-h-[70vh] flex-col justify-start space-y-4 pt-10 pb-16 first:border-t-0"
    >
      <p className="bg-primary text-background w-fit rounded px-2 py-1 font-mono text-xs tracking-wider">
        {step.label}
      </p>
      <h3 className="text-foreground text-2xl font-medium tracking-tight">{step.title}</h3>
      <p className="text-muted-foreground max-w-md text-base leading-relaxed">{step.description}</p>
      <ul className="text-muted-foreground max-w-md space-y-2 text-[15px] leading-relaxed">
        {step.bullets.map((bullet) => (
          <li key={bullet} className="flex gap-2">
            <KortixAsterisk index={index} />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      <div className="mt-8 h-full min-h-0 lg:hidden">
        <StepShowcaseFor step={step} />
      </div>
    </div>
  );
}

function StickyShowcasePanel({ steps, activeIndex }: { steps: Step[]; activeIndex: number }) {
  return (
    <div className="relative hidden overflow-visible lg:block">
      <div className="sticky top-40 overflow-visible">
        <div className="relative aspect-19/22 w-full overflow-visible">
          {steps.map((step, index) => (
            <div
              key={step.id}
              className={cn(
                'absolute inset-0 transition-opacity duration-300',
                index === activeIndex ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
            >
              <StepShowcaseFor step={step} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const tHome = useTranslations('hardcodedUi.appHomePage');
  const [activeIndex, setActiveIndex] = useState(0);
  const handleActive = useCallback((index: number) => setActiveIndex(index), []);

  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-16 max-w-2xl space-y-3">
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {tHome('howItWorksSectionTitle')}
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">
          {tHome('howItWorksSectionDescription')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-10 pt-10 lg:grid-cols-2 lg:gap-10">
        <div>
          {STEPS.map((step, index) => (
            <StepRow key={step.id} index={index} step={step} onActive={handleActive} />
          ))}
        </div>

        <StickyShowcasePanel steps={STEPS} activeIndex={activeIndex} />
      </div>
    </section>
  );
}
