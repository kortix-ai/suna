'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/marketing/button';
import { Heatmap } from '@paper-design/shaders-react';
import { Eye, Key, LayersTwo as Layers2, Servers as Server, Shield } from '@mynaui/icons-react';
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
          Isolation
        </div>
      );

    case 'soc2':
      return (
        <div className="relative flex h-full min-h-full w-full items-center justify-center">
          SOC2
        </div>
      );

    case 'selfhost':
      return (
        <div className="relative flex h-full min-h-full w-full items-center justify-center">
          Self-host
        </div>
      );

    default:
      return (
        <div className="relative flex h-full min-h-full w-full items-center justify-center">
          Default
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
        <div className="bg-foreground relative hidden h-full w-full overflow-hidden rounded-sm border-b lg:col-span-4 lg:block lg:border-r lg:border-b-0">
          <div className="relative flex h-full w-full items-center justify-center lg:scale-90">
            <Heatmap
              speed={1}
              contour={0.5}
              angle={0}
              noise={0}
              innerGlow={0.5}
              outerGlow={0.05}
              scale={0.65}
              image="https://app.paper.design/file-assets/01KSZX87JES96T455ZX3RRGMPP/01KT47X1FY5YNJN6EPP8TW6ZB1.svg"
              frame={407072.499999992}
              colors={['var(--kortix-orange)', '#fafafa', '#242424']}
              colorBack="#ffffff00"
              className="shrink-0"
              style={{
                // backgroundColor: 'var(--card)',
                height: '182px',
                width: '220px',
              }}
            />
          </div>
        </div>

        <div className="flex h-full min-h-0 flex-1 flex-col space-y-6 lg:col-span-8">
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
                  {tHome(item.title)}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pl-4 text-base leading-relaxed">
                  {tHome(item.body)}
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
