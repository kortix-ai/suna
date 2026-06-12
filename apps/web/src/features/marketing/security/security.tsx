'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/marketing/button';
import { ProgressiveBlur } from '@/components/ui/progressive-blur';
import { Eye, Key, Layers2, Server, Shield } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { ACCORDION, type AccordionIcon } from './content';

const ACCORDION_ICONS: Record<AccordionIcon, React.ReactNode> = {
  'stack-2': <Layers2 className="size-4" aria-hidden />,
  key: <Key className="size-4" aria-hidden />,
  eye: <Eye className="size-4" aria-hidden />,
  shield: <Shield className="size-4" aria-hidden />,
  server: <Server className="size-4" aria-hidden />,
};

const Block = ({ tab }: { tab: string }) => {
  switch (tab) {
    case 'isolation':
      return (
        <div className="relative flex h-full min-h-full w-full items-center justify-center">
          <ProgressiveBlur height="20%" className="absolute top-0 z-20 rotate-180" />
          <div className="from-kortix-base via-kortix-green/30 dark:via-kortix-green to-kortix-base absolute inset-y-px left-1/2 z-10 w-5 -translate-x-1/2 bg-linear-to-b">
            <div className="bg-card absolute top-1/2 right-0 left-0 h-[140px] -translate-y-1/2" />
          </div>

          <svg
            stroke="currentColor"
            fill="currentColor"
            strokeWidth="0"
            viewBox="0 0 512 512"
            height="200px"
            width="200px"
            className="text-foreground relative z-20"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="32"
              d="m434.8 137.65-149.36-68.1c-16.19-7.4-42.69-7.4-58.88 0L77.3 137.65c-17.6 8-17.6 21.09 0 29.09l148 67.5c16.89 7.7 44.69 7.7 61.58 0l148-67.5c17.52-8 17.52-21.1-.08-29.09zM160 308.52l-82.7 37.11c-17.6 8-17.6 21.1 0 29.1l148 67.5c16.89 7.69 44.69 7.69 61.58 0l148-67.5c17.6-8 17.6-21.1 0-29.1l-79.94-38.47"
            />
            <path
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="32"
              d="m160 204.48-82.8 37.16c-17.6 8-17.6 21.1 0 29.1l148 67.49c16.89 7.7 44.69 7.7 61.58 0l148-67.49c17.7-8 17.7-21.1.1-29.1L352 204.48"
            />
          </svg>

          <ProgressiveBlur height="20%" className="absolute bottom-0 z-20" />
        </div>
      );

    case 'soc2':
      return (
        <div className="relative flex h-full min-h-full w-full items-center justify-center">
          <ProgressiveBlur height="20%" className="absolute top-0 z-20 rotate-180" />
          <div className="from-kortix-base via-kortix-purple/30 dark:via-kortix-purple to-kortix-base absolute inset-y-px left-1/2 z-10 w-5 -translate-x-1/2 bg-linear-to-b">
            <div className="bg-card absolute top-1/2 right-0 left-0 h-[140px] -translate-y-1/2" />
          </div>

          <svg
            stroke="currentColor"
            fill="currentColor"
            stroke-width="0"
            viewBox="0 0 24 24"
            height="200px"
            width="200px"
            xmlns="http://www.w3.org/2000/svg"
            className="text-foreground relative z-20"
          >
            <path d="M11.998 2l.118 .007l.059 .008l.061 .013l.111 .034a.993 .993 0 0 1 .217 .112l.104 .082l.255 .218a11 11 0 0 0 7.189 2.537l.342 -.01a1 1 0 0 1 1.005 .717a13 13 0 0 1 -9.208 16.25a1 1 0 0 1 -.502 0a13 13 0 0 1 -9.209 -16.25a1 1 0 0 1 1.005 -.717a11 11 0 0 0 7.531 -2.527l.263 -.225l.096 -.075a.993 .993 0 0 1 .217 -.112l.112 -.034a.97 .97 0 0 1 .119 -.021l.115 -.007zm3.71 7.293a1 1 0 0 0 -1.415 0l-3.293 3.292l-1.293 -1.292l-.094 -.083a1 1 0 0 0 -1.32 1.497l2 2l.094 .083a1 1 0 0 0 1.32 -.083l4 -4l.083 -.094a1 1 0 0 0 -.083 -1.32z"></path>
          </svg>
          <ProgressiveBlur height="20%" className="absolute bottom-0 z-30" />
        </div>
      );

    case 'selfhost':
      return (
        <div className="relative flex h-full min-h-full w-full items-center justify-center">
          <ProgressiveBlur height="20%" className="absolute top-0 z-20 rotate-180" />
          <div className="from-kortix-base via-kortix-yellow/30 dark:via-kortix-yellow to-kortix-base absolute inset-y-px left-1/2 z-10 w-5 -translate-x-1/2 bg-linear-to-b" />
          <div className="bg-foreground text-background border-border/25 dark:border-border relative z-20 flex w-fit shrink-0 items-center justify-center rounded-lg px-8 py-4">
            <h1 className="text-background text-5xl font-medium tracking-tight">kortix ship</h1>
          </div>
          <ProgressiveBlur height="20%" className="absolute bottom-0 z-20" />
        </div>
      );

    default:
      return (
        <div className="relative flex h-full min-h-full w-full items-center justify-center">
          <ProgressiveBlur height="20%" className="absolute top-0 z-20 rotate-180" />
          <div className="from-kortix-base via-kortix-green/30 dark:via-kortix-green to-kortix-base absolute inset-y-px left-1/2 z-10 w-5 -translate-x-1/2 bg-linear-to-b">
            <div className="bg-card absolute top-1/2 right-0 left-0 h-[140px] -translate-y-1/2" />
          </div>

          <svg
            stroke="currentColor"
            fill="currentColor"
            strokeWidth="0"
            viewBox="0 0 512 512"
            height="200px"
            width="200px"
            className="text-foreground relative z-20"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="32"
              d="m434.8 137.65-149.36-68.1c-16.19-7.4-42.69-7.4-58.88 0L77.3 137.65c-17.6 8-17.6 21.09 0 29.09l148 67.5c16.89 7.7 44.69 7.7 61.58 0l148-67.5c17.52-8 17.52-21.1-.08-29.09zM160 308.52l-82.7 37.11c-17.6 8-17.6 21.1 0 29.1l148 67.5c16.89 7.69 44.69 7.69 61.58 0l148-67.5c17.6-8 17.6-21.1 0-29.1l-79.94-38.47"
            />
            <path
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="32"
              d="m160 204.48-82.8 37.16c-17.6 8-17.6 21.1 0 29.1l148 67.49c16.89 7.7 44.69 7.7 61.58 0l148-67.49c17.7-8 17.7-21.1.1-29.1L352 204.48"
            />
          </svg>

          <ProgressiveBlur height="20%" className="absolute bottom-0 z-20" />
        </div>
      );
  }
};

const Security = () => {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tHome = useCallback(
    (key: string) => tHardcodedUi.raw(`appHomePage.${key}`),
    [tHardcodedUi],
  );

  const [activeId, setActiveId] = useState<string>(ACCORDION[0].id);

  return (
    <section className="mx-auto max-w-6xl rounded-sm px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-16 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {tHome('enterpriseEyebrow')}
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {tHome('enterpriseTitle')}
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">
          {tHome('enterpriseDescription')}
        </p>
      </div>

      <div className="border-border bg-card grid min-h-[390px] w-full overflow-hidden rounded-sm border lg:grid-cols-12">
        <div className="relative w-full border-b lg:col-span-5 lg:border-r lg:border-b-0">
          <Block tab={activeId} />
        </div>

        <div className="flex h-full min-h-0 flex-1 flex-col space-y-6 lg:col-span-7">
          <Accordion
            type="single"
            collapsible
            className="w-full"
            value={activeId}
            onValueChange={setActiveId}
          >
            {ACCORDION.map((item) => (
              <AccordionItem key={item.id} value={item.id} className="px-4 py-2 lg:last:border-b">
                <AccordionTrigger className="group/trigger [&[data-state=open]>svg]:text-primary text-foreground px-4 py-5 text-lg font-medium hover:no-underline lg:text-xl">
                  {tHome(item.titleKey)}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pl-4 text-base leading-relaxed">
                  {tHome(item.bodyKey)}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>

          <div className="mt-auto px-4 pb-7">
            <Button size="sm" className="w-fit" asChild>
              <Link href="/enterprise">{tHome('enterpriseLearnMore')}</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Security;
