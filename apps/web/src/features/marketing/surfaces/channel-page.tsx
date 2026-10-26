import Link from '@/components/site-link';
import { CheckIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { MarketingButton } from '../kit/marketing-button';
import { Band, Block, Heading, PageFrame } from '../kit/page-frame';
import { Message, ThreadCard, ThreadCardStack } from './chat';
import type { ChannelContent, StepVisual } from './channel-content';
import { CompareTabs } from './compare-tabs';
import type { SurfaceContent } from './content';
import { OtherSurfaces, SurfaceHero } from './surface-page';

/*
 * /slack and /teams. The page structure (hero window, a
 * statement, people and agents in one thread, three traits, a chatbot-versus-
 * Kortix comparison, three install steps, control, FAQ), drawn in Kortix's
 * bordered layout: every section is a two-tone title over a band whose
 * hairlines cross the page, and its cells split by hairlines. Visuals are white
 * cards on the card surface. No testimonials until approved quotes exist.
 */

/** The card surface a visual stands on, its content centred. */
function Tile({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-card flex items-center justify-center p-6 lg:p-10 ${className}`}>{children}</div>
  );
}

function TwoTone({ title, titleMuted, size = 'lg' }: { title: string; titleMuted: string; size?: 'lg' | 'md' }) {
  return (
    <h3
      className={
        size === 'lg'
          ? 'text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl'
          : 'text-lg font-medium tracking-tight text-balance'
      }
    >
      <span className="text-foreground block">{title}</span>
      <span className="text-muted-foreground block">{titleMuted}</span>
    </h3>
  );
}

function StepVisualCard({ visual }: { visual: StepVisual }) {
  if (visual.kind === 'install') {
    return (
      <ul className="flex w-full max-w-xs flex-col gap-2">
        {visual.rows.map((row) => (
          <li key={row.label} className="bg-background flex items-center gap-3 rounded-md border px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-foreground text-sm font-medium">{row.label}</span>
              <span className="text-muted-foreground truncate font-mono text-xs">{row.detail}</span>
            </span>
            <CheckIcon aria-hidden className="text-foreground size-4 shrink-0" />
          </li>
        ))}
      </ul>
    );
  }
  if (visual.kind === 'message') {
    return (
      <ul className="bg-background w-full max-w-xs rounded-md border p-4">
        <Message message={visual.message} />
      </ul>
    );
  }
  return (
    <div className="bg-background w-full max-w-xs rounded-md">
      <ThreadCard card={visual.card} />
    </div>
  );
}

export function ChannelPage({
  surface,
  channel,
  stage,
}: {
  surface: SurfaceContent;
  channel: ChannelContent;
  stage: ReactNode;
}) {
  const { statement, together, traits, compare, steps, control, faq } = channel;
  return (
    <PageFrame>
      <SurfaceHero content={surface} stage={stage} />

      {/* A statement, centred, with one way in. */}
      <section id="statement" className="flex flex-col items-center gap-8 px-8 py-24 text-center lg:px-28 lg:py-32">
        <h2 className="text-2xl font-medium tracking-tight text-balance md:text-3xl lg:text-4xl">
          <span className="text-foreground block">{statement.title}</span>
          <span className="text-muted-foreground block">{statement.titleMuted}</span>
        </h2>
        <MarketingButton size="md" className="hit-area-y-1" asChild>
          <Link href={statement.cta.href}>{statement.cta.label}</Link>
        </MarketingButton>
      </section>

      {/* People and agents in one thread: copy and one fact left, the thread right. */}
      <Band>
        <div className="grid grid-cols-1 lg:grid-cols-[5fr_7fr]">
          <div className="flex flex-col justify-between gap-12 p-8 lg:p-12">
            <div className="flex flex-col gap-6">
              <TwoTone title={together.title} titleMuted={together.titleMuted} />
              {together.body.map((p) => (
                <p key={p} className="text-muted-foreground text-base text-pretty">
                  {p}
                </p>
              ))}
            </div>
            <div className="flex flex-col gap-1 border-t pt-6">
              <span className="text-muted-foreground text-sm">{together.fact.k}</span>
              <span className="text-foreground text-base text-pretty">{together.fact.v}</span>
            </div>
          </div>
          <Tile className="border-t lg:border-t-0 lg:border-l">
            <ThreadCardStack channel={together.channel} messages={together.messages} />
          </Tile>
        </div>
      </Band>

      {/* Three traits, each a two-tone line over a card that shows it. */}
      <Block id="traits">
        <Heading title={traits.title} titleMuted={traits.titleMuted} />
        <Band className="mt-12">
          <ul className="bg-border grid grid-cols-1 gap-px lg:grid-cols-3">
            {traits.items.map((item) => (
              <li key={item.title} className="bg-background flex flex-col">
                <div className="flex flex-col gap-3 p-6 lg:p-8">
                  <TwoTone title={item.title} titleMuted={item.titleMuted} size="md" />
                  <p className="text-muted-foreground text-sm text-pretty">{item.line}</p>
                </div>
                <Tile className="min-h-64 flex-1 border-t">
                  <div className="bg-background w-full max-w-xs rounded-md">
                    <ThreadCard card={item.card} />
                  </div>
                </Tile>
              </li>
            ))}
          </ul>
        </Band>
      </Block>

      {/* A chatbot answers; Kortix does the work. One task per tab. */}
      <Block id="difference">
        <Heading title={compare.title} titleMuted={compare.titleMuted} sub={compare.sub} />
        <Band className="mt-12">
          <CompareTabs tabs={compare.tabs} />
        </Band>
      </Block>

      {/* Install: three steps, each a card above its numbered line. */}
      <Block id="setup">
        <Heading title={steps.title} titleMuted={steps.titleMuted} />
        <Band className="mt-12">
          <ol className="bg-border grid grid-cols-1 gap-px lg:grid-cols-3">
            {steps.items.map((step, i) => (
              <li key={step.title} className="bg-background flex flex-col">
                <Tile className="min-h-56 border-b">
                  <StepVisualCard visual={step.visual} />
                </Tile>
                <div className="flex flex-col gap-2 p-6 lg:p-8">
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">0{i + 1}</span>
                  <h3 className="text-foreground text-base font-medium">{step.title}</h3>
                  <p className="text-muted-foreground text-sm text-pretty">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Band>
      </Block>

      {/* Control: the promise and three checks left, a thread that keeps it right. */}
      <Band>
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <div className="flex flex-col gap-8 p-8 lg:p-12">
            <div className="flex flex-col gap-6">
              <TwoTone title={control.title} titleMuted={control.titleMuted} />
              <p className="text-muted-foreground text-base text-pretty">{control.body}</p>
            </div>
            <ul className="flex flex-col divide-y border-y">
              {control.checks.map((check) => (
                <li key={check} className="flex items-start gap-3 py-4">
                  <CheckIcon aria-hidden className="text-ring mt-0.5 size-4 shrink-0" />
                  <span className="text-foreground text-sm text-pretty">{check}</span>
                </li>
              ))}
            </ul>
            <MarketingButton variant="secondary" size="md" className="hit-area-y-1 w-fit" asChild>
              <Link href={control.link.href}>{control.link.label}</Link>
            </MarketingButton>
          </div>
          <Tile className="border-t lg:border-t-0 lg:border-l">
            <ThreadCardStack channel={control.channel} messages={control.messages} />
          </Tile>
        </div>
      </Band>

      {/* FAQ: the title left, questions as hairline rows right. */}
      <Block id="faq">
        <div className="grid grid-cols-1 gap-10 px-8 lg:grid-cols-[4fr_8fr] lg:gap-16 lg:px-28">
          <TwoTone title={faq.title} titleMuted={faq.titleMuted} />
          <div className="flex flex-col border-t">
            {faq.items.map((item, i) => (
              <details key={item.q} open={i === 0} className="group border-b">
                <summary className="text-foreground outline-ring flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-base font-medium focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <PlusIcon
                    aria-hidden
                    className="text-muted-foreground size-4 shrink-0 transition-transform duration-moderate ease-out group-open:rotate-45"
                  />
                </summary>
                <p className="text-muted-foreground pb-6 text-base text-pretty">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </Block>

      <OtherSurfaces current={channel.id} />
    </PageFrame>
  );
}
