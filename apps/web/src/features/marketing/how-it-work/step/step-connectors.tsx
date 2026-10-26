'use client';

import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import { BrandGlyph } from '@/features/marketing/kit/brand-glyph';
import { m, useInView, useReducedMotion } from 'motion/react';
import Image from 'next/image';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useStepShowcaseStart } from '../use-step-showcase';

/**
 * Layer 02 — the tools, written as one sentence (Paper "Kortix 2", connect
 * tools, C10): "Your agents work in Slack, Notion, Linear, HubSpot, Stripe
 * and GitHub.", each name led by its official logo, then two facts on a
 * hairline.
 *
 * Logos: official marks in their brand colours. Single-colour marks draw
 * through `BrandGlyph` (colours from `works-with-logos.ts`; Notion and GitHub
 * are black marks and draw in ink, so they follow the theme). Slack's mark is
 * four colours, so it is an image, as is every other multi-colour mark.
 *
 * The sentence names six tools at a time and swaps to the next six every
 * 10 seconds while the panel is on screen, so it reads as "and the rest of
 * your stack" without printing a number.
 *
 * ACCURACY GATE:
 *   - Only CONNECTOR credentials stay on the server. A granted runtime secret
 *     does reach the machine, so never write "no credential in the machine".
 *   - Rules are allow, ask or block per call, down to the arguments. They are
 *     opt-in, so never write that every call pauses.
 *
 * MOTION. A fade-and-rise, word group by word group, when the panel first
 * scrolls in and on every swap; the old names fade out first. Reduced motion
 * shows the first six and never swaps.
 */

type Tool = { slug: string; name: string; image?: string };

const COLOR = '/media/landing/logos/color';

/** Six tools a sentence. Each set mixes chat, docs, work, CRM, money and code. */
const SETS: Tool[][] = [
  [
    { slug: 'slack', name: 'Slack', image: `${COLOR}/slack.svg` },
    { slug: 'notion', name: 'Notion' },
    { slug: 'linear', name: 'Linear' },
    { slug: 'hubspot', name: 'HubSpot' },
    { slug: 'stripe', name: 'Stripe' },
    { slug: 'github', name: 'GitHub' },
  ],
  [
    { slug: 'gmail', name: 'Gmail', image: `${COLOR}/gmail.svg` },
    { slug: 'googledrive', name: 'Google Drive', image: `${COLOR}/googledrive.svg` },
    { slug: 'jira', name: 'Jira' },
    { slug: 'salesforce', name: 'Salesforce' },
    { slug: 'quickbooks', name: 'QuickBooks' },
    { slug: 'gitlab', name: 'GitLab' },
  ],
  [
    { slug: 'intercom', name: 'Intercom', image: `${COLOR}/intercom.svg` },
    { slug: 'confluence', name: 'Confluence', image: `${COLOR}/confluence.svg` },
    { slug: 'asana', name: 'Asana' },
    { slug: 'airtable', name: 'Airtable', image: `${COLOR}/airtable.svg` },
    { slug: 'shopify', name: 'Shopify' },
    { slug: 'figma', name: 'Figma', image: `${COLOR}/figma.svg` },
  ],
];

const SWAP_MS = 10_000;
/** How long the old names take to fade before the new ones come in. */
const OUT_MS = 300;

const COPY = {
  lead: 'Your agents work in',
  and: 'and',
  keysTitle: 'Connector keys stay on the server',
  keysBody: 'The session machine never sees them.',
  rulesTitle: 'Allow, ask or block',
  rulesBody: 'Set per call, down to its arguments.',
};

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export function StepConnectors(): ReactNode {
  const copy = useLocalizedUiCatalog(COPY);
  const reduced = useReducedMotion();
  const [started, setStarted] = useState(false);
  const rootRef = useStepShowcaseStart(useCallback(() => setStarted(true), []));
  const shown = started || !!reduced;
  const onScreen = useInView(rootRef);
  const [set, setSet] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (reduced || !started || !onScreen) return;
    let swap: number | undefined;
    const id = window.setInterval(() => {
      setLeaving(true);
      swap = window.setTimeout(() => {
        setSet((i) => (i + 1) % SETS.length);
        setLeaving(false);
      }, OUT_MS);
    }, SWAP_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(swap);
    };
  }, [reduced, started, onScreen]);

  const tools = SETS[set];

  // Word groups in reading order: each tool, "and" before the last. Keys carry
  // the set, so a swap mounts fresh words that rise in.
  const groups: { key: string; node: ReactNode; muted?: boolean }[] = [
    ...tools.flatMap((tool, i) => {
      const last = i === tools.length - 1;
      const mark = tool.image ? (
        <Image src={tool.image} alt="" width={28} height={28} unoptimized className="size-5 sm:size-6 lg:size-7" />
      ) : (
        <BrandGlyph slug={tool.slug} className="size-5 sm:size-6 lg:size-7" />
      );
      const word = {
        key: `${set}-${tool.slug}`,
        node: (
          <span className="inline-flex items-center gap-2">
            {mark}
            {tool.name}
            {last ? '.' : i === tools.length - 2 ? '' : ','}
          </span>
        ),
      };
      return last ? [{ key: `${set}-and`, node: copy.and, muted: true }, word] : [word];
    }),
  ];

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 w-full flex-col justify-center gap-8"
    >
      <p className="text-foreground flex flex-wrap items-center gap-x-3 gap-y-2 text-xl tracking-tight sm:text-2xl lg:text-3xl">
        <m.span
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={shown ? { opacity: 1, y: 0 } : undefined}
          transition={{ duration: 0.4, ease: EASE_OUT }}
          className="text-muted-foreground"
        >
          {copy.lead}
        </m.span>
        {groups.map((group, i) => (
          <m.span
            key={group.key}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={shown && !leaving ? { opacity: 1, y: 0 } : { opacity: 0, y: leaving ? -4 : 6 }}
            transition={
              leaving
                ? { duration: OUT_MS / 1000, ease: EASE_OUT }
                : { duration: 0.4, ease: EASE_OUT, delay: (i + 1) * 0.05 }
            }
            className={group.muted ? 'text-muted-foreground' : undefined}
          >
            {group.node}
          </m.span>
        ))}
      </p>

      <m.dl
        initial={reduced ? false : { opacity: 0 }}
        animate={shown ? { opacity: 1 } : undefined}
        transition={{ duration: 0.4, ease: EASE_OUT, delay: (groups.length + 1) * 0.05 }}
        className="border-border grid grid-cols-1 gap-6 border-t pt-6 sm:grid-cols-2"
      >
        <div className="flex flex-col gap-1">
          <dt className="text-foreground text-sm">{copy.keysTitle}</dt>
          <dd className="text-muted-foreground text-sm">{copy.keysBody}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-foreground text-sm">{copy.rulesTitle}</dt>
          <dd className="text-muted-foreground text-sm">{copy.rulesBody}</dd>
        </div>
      </m.dl>
    </div>
  );
}
