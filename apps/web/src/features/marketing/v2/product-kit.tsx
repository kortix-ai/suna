'use client';

import type { SectionSpec } from '@/features/marketing/v2/page-kit';
import { Eyebrow, Section, SoftCard } from '@/features/marketing/v2/primitives';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

/**
 * Local helpers for the five product pages (/v2/agents, /v2/sandboxes,
 * /v2/connectors, /v2/automations, /v2/agent-templates).
 *
 * The copy still lives in `pages-content.ts`; these pages pull one section out
 * of it at a time so each can place its own sections instead of going through
 * the generic dispatcher. Nothing here renders product imagery — visuals stay
 * with `RealVisual`.
 */

/** A section's words, without the layout hints the page decides for itself. */
export type SectionCopy = {
  id: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  visual?: string;
  eyebrow?: string;
};

/** Pulls one section's copy out of a page's list so the page can place it. */
export function sectionCopy(sections: SectionSpec[], id: string): SectionCopy | undefined {
  const found = sections.find((section) => section.id === id);
  if (!found) return undefined;
  const { id: sectionId, heading, body, bullets, visual, eyebrow } = found;
  return { id: sectionId, heading, body, bullets, visual, eyebrow };
}

/* ── cross-links ─────────────────────────────────────────────────────────── */

/** Mirrors the Product menu in `content.ts` — same names, same descriptions. */
const PRODUCT_PAGES = [
  { name: 'Agents', description: 'Markdown personas with scoped reach', href: '/v2/agents' },
  {
    name: 'Sandboxes',
    description: 'Every session on its own machine and branch',
    href: '/v2/sandboxes',
  },
  { name: 'Connectors', description: 'One scoped token into 3,000+ apps', href: '/v2/connectors' },
  {
    name: 'Automations',
    description: 'Triggers that start work on a cron or a webhook',
    href: '/v2/automations',
  },
  {
    name: 'Agent templates',
    description: 'Working agents for the jobs you repeat',
    href: '/v2/agent-templates',
  },
];

/** The rest of the platform, so a product page is never a dead end. */
export function MoreProduct({ current }: { current: string }) {
  const rest = PRODUCT_PAGES.filter((page) => page.href !== current);

  return (
    <Section id="more-product">
      <Eyebrow>More of the platform</Eyebrow>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {rest.map((page) => (
          <Link key={page.href} href={page.href} className="group block">
            <SoftCard className="h-full transition-transform duration-200 group-hover:-translate-y-0.5">
              <p className="text-foreground flex items-center gap-1.5 text-[1.0625rem] font-medium">
                {page.name}
                <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </p>
              <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.5]">
                {page.description}
              </p>
            </SoftCard>
          </Link>
        ))}
      </div>
    </Section>
  );
}
