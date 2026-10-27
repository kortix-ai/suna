'use client';

import Link from '@/components/site-link';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { cn } from '@kortix/ui';
import { Github } from '@kortix/ui/internal/icons/github';
import { ArrowUpRightIcon, StarIcon } from '@phosphor-icons/react';
import { type KeyboardEvent, type Ref } from 'react';

export type MegaMenuLink = { label: string; href: string; external?: boolean };

/** One column of the panel: a muted heading over a plain list of links. */
export type MegaMenuGroup = { title: string; links: MegaMenuLink[] };

export type MegaMenu = {
  id: 'product' | 'resources';
  label: string;
  groups: MegaMenuGroup[];
};

/**
 * The three menus of the bar. Every href is a live route. Plain English,
 * localized through the site-config catalog wherever the same words already
 * have a key.
 */
export const MEGA_MENUS: MegaMenu[] = [
  {
    id: 'product',
    label: 'Product',
    // What the product is and what it is made of. Pricing lives in the bar
    // only. The pillar links land on the home page's pillar cells (ids in
    // landing-sections/pillars-band.tsx); the building blocks open their docs.
    groups: [
      {
        title: 'The AI OS',
        links: [
          { label: 'Multiplayer AI', href: '/#multiplayer' },
          { label: 'Company as code', href: '/#company-as-code' },
          { label: 'Sovereign and open', href: '/#sovereign' },
          { label: 'Outcomes, 24/7', href: '/#use-cases' },
        ],
      },
      {
        title: 'Building blocks',
        // Each opens its Guide page (docs revamp, 2026-10-27).
        links: [
          { label: 'Agents', href: '/docs#agents' },
          { label: 'Skills', href: '/docs#skills' },
          // Apps: the compute platform (sites, internal tools, backends with data,
          // functions and realtime).
          { label: 'Apps', href: '/docs#apps' },
          // Drive: shared folders for people and agents (the Files feature).
          { label: 'Drive', href: '/docs#memory-and-drive' },
          { label: 'Connectors', href: '/docs#connectors' },
          { label: 'Automations', href: '/docs#automations' },
          { label: 'Computers', href: '/docs#computers' },
          { label: 'Models', href: '/docs#models' },
        ],
      },
      {
        // ACCURACY: the channel set is Slack, Microsoft Teams and email
        // (kortix-brand claims.md). Email has no page yet.
        title: 'Use it from',
        links: [
          { label: 'Desktop', href: '/desktop' },
          { label: 'Mobile', href: '/mobile' },
          { label: 'CLI', href: '/cli' },
          { label: 'Slack', href: '/slack' },
          { label: 'Microsoft Teams', href: '/teams' },
        ],
      },
      {
        title: 'Run it',
        links: [
          { label: 'Security', href: '/security' },
          // ACCURACY: never "air-gapped" (see site-config.ts).
          { label: 'Self-hosted', href: '/self-hosted' },
          { label: 'Enterprise', href: '/enterprise' },
        ],
      },
    ],
  },
  {
    id: 'resources',
    // /developers stays live but is in no menu (founder, 2026-10-27).
    label: 'Resources',
    groups: [
      {
        title: 'Learn',
        links: [
          { label: 'Guide', href: '/docs' },
          { label: 'Use cases', href: '/use-cases' },
          { label: 'Blog', href: '/blog' },
          { label: 'Changelog', href: '/changelog' },
        ],
      },
      {
        title: 'Get Kortix',
        links: [
          { label: 'Download', href: '/download' },
          { label: 'Marketplace', href: '/marketplace' },
        ],
      },
      {
        title: 'Company',
        links: [
          { label: 'About', href: '/about' },
          { label: 'Careers', href: '/careers' },
          { label: 'Contact', href: '/contact' },
          { label: 'Legal', href: '/legal/terms' },
        ],
      },
    ],
  },
];

type MegaMenuPanelProps = {
  menu: MegaMenu;
  open: boolean;
  ref?: Ref<HTMLDivElement>;
  /** A link was chosen: the menu closes. */
  onNavigate: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** The repo's star count, already formatted (the bar's own fetch); null hides it. */
  stars?: string | null;
};

const REPO = 'kortix-ai/suna';
const REPO_URL = `https://github.com/${REPO}`;

/**
 * The open-source tile in the Resources panel's free fourth column: an
 * inverted block with the GitHub mark on top, and the claim, the live star
 * count with the repo, and the way in at the bottom. The whole tile is one link.
 */
function OpenSourceCard({ stars, onNavigate }: { stars?: string | null; onNavigate: () => void }) {
  return (
    <Link
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onNavigate}
      className="group/repo bg-foreground text-background outline-ring flex flex-col justify-between gap-8 rounded-lg p-5 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <Github className="size-8 shrink-0" />
      <span className="flex flex-col">
        <span className="text-lg font-medium">Kortix is open source</span>
        <span className="text-background/60 mt-1 flex items-center gap-1.5 text-sm">
          {stars ? (
            <>
              <StarIcon weight="fill" className="size-3.5 shrink-0" />
              <span className="tabular-nums">{stars}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          {REPO}
        </span>
        <span className="group-hover/repo:text-ring mt-4 inline-flex items-center gap-1.5 text-sm transition-colors duration-moderate">
          View on GitHub
          <ArrowUpRightIcon className="size-3.5 opacity-0 transition-opacity duration-moderate group-hover/repo:opacity-100 group-focus-visible/repo:opacity-100" />
        </span>
      </span>
    </Link>
  );
}

/**
 * One full-width panel: up to four columns, each a muted group heading over
 * a plain list of links. An external link carries a small up-right arrow.
 * Every panel sits in one grid cell, so switching menus cross-fades in place;
 * a closed panel is inert.
 */
export function MegaMenuPanel({ menu, open, ref, onNavigate, onKeyDown, stars }: MegaMenuPanelProps) {
  return (
    <div
      ref={ref}
      id={`mega-${menu.id}`}
      inert={!open}
      onKeyDown={onKeyDown}
      className={cn(
        'col-start-1 row-start-1 transition-[opacity,visibility] duration-normal ease-out',
        open ? 'opacity-100' : 'invisible opacity-0',
      )}
    >
      <div className={cn(MARKETING_CONTAINER, 'grid grid-cols-4 gap-8 pt-8 pb-12')}>
        {menu.groups.map((group) => (
          <div key={group.title}>
            <p className="text-muted-foreground text-sm">{group.title}</p>
            {/* Each link fills its column and carries the row gap as padding,
                so the whole row is the target and the rows touch: no dead
                strip between two links, and the hover tint shows anywhere on
                the row. Same spacing as before (gap-3 = 2 × py-1.5). */}
            <ul className="mt-2.5 flex flex-col">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    onClick={onNavigate}
                    {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    className="text-foreground hover:text-ring outline-ring flex w-full items-center gap-1.5 rounded-sm py-1.5 text-base transition-colors duration-moderate focus-visible:outline-2"
                  >
                    {link.label}
                    {link.external && <ArrowUpRightIcon className="size-3.5" />}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {menu.id === 'resources' && <OpenSourceCard stars={stars} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}
