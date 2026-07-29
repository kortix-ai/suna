'use client';

import { splitBullet } from '@/features/marketing/v2/page-kit';
import {
  CheckLine,
  Display,
  Eyebrow,
  Lead,
  Panel,
  Pill,
  Section,
  SoftCard,
} from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';

/**
 * Local section shapes for the three trust routes: /v2/security, /v2/enterprise
 * and /v2/self-hosted.
 *
 * These pages are read by security reviewers and answered from during
 * procurement, so they trade marketing rhythm for spec-sheet legibility:
 * indexed facts, term/definition rows, and a compliance block that states the
 * audit status rather than implying a certification. Everything below is built
 * from the shared primitives and inherits both themes from them.
 */

export type TrustLink = { label: string; href: string };

/** Strips the trailing period a lede carries so it can be used as a title. */
const asTitle = (lede: string) => lede.replace(/[.:]$/, '');

const COLS = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
} as const;

type Columns = keyof typeof COLS;

/* ── indexed facts ───────────────────────────────────────────────────────── */

/**
 * A short, countable list of guarantees. The ordinals are the point: the
 * heading claims a fixed number of things, so the cards are numbered and a
 * reader can check the claim against the page.
 */
export function TruthGrid({
  id,
  heading,
  body,
  items,
  columns = 2,
  tone = 'plain',
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  items: string[];
  columns?: Columns;
  tone?: 'plain' | 'muted';
}) {
  return (
    <Section id={id} tone={tone}>
      <div className="mx-auto max-w-2xl text-center">
        <Display lines={heading} />
        {body && <Lead className="mt-6">{body}</Lead>}
      </div>

      <div className={cn('mt-14 grid gap-4', COLS[columns])}>
        {items.map((item, i) => {
          const { lede, rest } = splitBullet(item);
          return (
            <SoftCard key={item}>
              <span className="text-muted-foreground/60 font-mono text-xs tabular-nums">
                {String(i + 1).padStart(2, '0')}
              </span>
              <p className="text-foreground mt-3 text-[1.125rem] font-medium">{asTitle(lede)}</p>
              {rest && (
                <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">{rest}</p>
              )}
            </SoftCard>
          );
        })}
      </div>
    </Section>
  );
}

/* ── term / definition rows ──────────────────────────────────────────────── */

/**
 * The procurement answer sheet: hairline rows a reviewer can scan for a single
 * term instead of reading a card wall.
 *
 * The term/detail boundary is written out rather than parsed out of a sentence,
 * because a reviewer who reads only the bold terms has to come away with the
 * same answer as one who reads everything — "SOC 2 Type II — in progress" is
 * the term, not "SOC 2 Type II".
 */
export function AnswerRows({
  id,
  heading,
  body,
  items,
  columns = 3,
  tone = 'plain',
  link,
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  items: { term: string; detail: string }[];
  columns?: Columns;
  tone?: 'plain' | 'muted';
  link?: TrustLink;
}) {
  return (
    <Section id={id} tone={tone}>
      <div className="mx-auto max-w-2xl text-center">
        <Display lines={heading} />
        {body && <Lead className="mt-6">{body}</Lead>}
      </div>

      <dl className={cn('mt-12 grid gap-x-12', COLS[columns])}>
        {items.map((item) => (
          <div key={item.term} className="border-border border-t py-6">
            <dt className="text-foreground text-[1.0625rem] font-medium">{item.term}</dt>
            <dd className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.6]">
              {item.detail}
            </dd>
          </div>
        ))}
      </dl>

      {link && (
        <div className="mt-10 flex justify-center">
          <Pill as="a" href={link.href} variant="soft">
            {link.label}
          </Pill>
        </div>
      )}
    </Section>
  );
}

/* ── heading beside a checklist ──────────────────────────────────────────── */

/**
 * For the sections whose points are assertions rather than features: the claim
 * on the left, the conditions that make it true on the right.
 */
export function ChecklistSplit({
  id,
  heading,
  body,
  bullets,
  tone = 'plain',
  link,
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets: string[];
  tone?: 'plain' | 'muted';
  link?: TrustLink;
}) {
  return (
    <Section id={id} tone={tone}>
      <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <div>
          <Display lines={heading} />
          {body && <Lead className="mt-6">{body}</Lead>}
          {link && (
            <Pill as="a" href={link.href} variant="soft" className="mt-8">
              {link.label}
            </Pill>
          )}
        </div>

        <ul className="self-center">
          {bullets.map((b) => (
            <li key={b} className="border-border border-t py-5">
              <CheckLine>{b}</CheckLine>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

/* ── compliance ──────────────────────────────────────────────────────────── */

/**
 * The one block on the site that talks about an audit. It leads with the status
 * so nobody can skim it into a certification we have not earned.
 */
export function ComplianceNote({
  id,
  eyebrow,
  status,
  heading,
  body,
  link,
}: {
  id?: string;
  eyebrow: string;
  status: string;
  heading: string | string[];
  body: string;
  link?: TrustLink;
}) {
  return (
    <Panel id={id}>
      <div className="px-8 py-12 sm:px-14 sm:py-16">
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-16">
          <div>
            <Eyebrow>{eyebrow}</Eyebrow>
            <Display lines={heading} />
            <p className="border-border bg-background/70 text-foreground mt-7 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[0.8125rem] font-medium">
              <span
                aria-hidden
                data-a11y-decorative
                className="bg-kortix-blue size-1.5 rounded-full"
              />
              {status}
            </p>
          </div>
          <div className="lg:pt-2">
            <Lead>{body}</Lead>
            {link && (
              <Pill as="a" href={link.href} variant="soft" className="mt-8">
                {link.label}
              </Pill>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
