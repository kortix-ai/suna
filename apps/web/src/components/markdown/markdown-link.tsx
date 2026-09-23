'use client';

/**
 * The link layer shared by `UnifiedMarkdown` and `DocMarkdown`.
 *
 * Two renderers, one decision:
 *
 * - `MarkdownInlineLink` is the `a` renderer — a brand-blue underlined link,
 *   or the setup card for an agent-minted setup link.
 * - `withActionBlock` runs in the `p` and `h1`–`h6` renderers. When a block
 *   holds nothing but links (plus arrow glyphs), and EVERY link classifies as
 *   an action, the block renders as Kortix actions instead of text: a card for
 *   a setup or connect link, a button chip for an internal or external link.
 *   One link that is not an action (a hash, a bare URL) keeps the whole block
 *   as text, so a block never renders half as prose and half as buttons.
 *
 * The decision itself lives in `markdown-action-link.ts` (pure, no React).
 */

import { InsideLinkContext } from '@/components/markdown/code/inside-link-context';
import {
  classifyMarkdownActionLink,
  standaloneActionLinks,
  type MarkdownActionIcon,
  type MarkdownActionLink,
} from '@/components/markdown/markdown-action-link';
import { isInternalUrl, shouldUseNextLink } from '@/components/markdown/unified-markdown-utils';
import { SetupLinkButton } from '@/components/setup-links/setup-link-button';
import { parseSetupLinkHref } from '@/components/setup-links/util';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { OutcomeCard } from '@/features/session/outcomes/outcome-card';
import type { Outcome } from '@/features/session/outcomes/outcome-types';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { cn } from '@/lib/utils';
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  ChatCircleIcon,
  FolderIcon,
  GearIcon,
  MagnifyingGlassIcon,
  PlugIcon,
  type Icon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import React, { useMemo, useSyncExternalStore } from 'react';

/** The renderers' sandbox proxy: rewrites a sandbox-local URL, passes others through. */
export type MarkdownProxy = (url: string | undefined) => string | undefined;

const COPY = {
  opensInNewTab: 'Opens in a new tab',
  opensInNewTabSuffix: '(opens in a new tab)',
  connect: 'Connect',
} as const;

const ACTION_ICON: Record<MarkdownActionIcon, Icon> = {
  plug: PlugIcon,
  search: MagnifyingGlassIcon,
  folder: FolderIcon,
  settings: GearIcon,
  chat: ChatCircleIcon,
  'arrow-right': ArrowRightIcon,
  'arrow-up-right': ArrowUpRightIcon,
};

const INLINE_LINK_CLASS = cn(
  'font-medium text-kortix-blue',
  'underline decoration-kortix-blue/40 decoration-[1px] underline-offset-[3px]',
  'transition-colors hover:decoration-kortix-blue',
  '[overflow-wrap:anywhere]',
);

function handleHashClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (!href.startsWith('#')) return;
  e.preventDefault();
  document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Links — brand-blue, routed through next/link. Setup links open an in-app modal. */
export function MarkdownInlineLink({
  href,
  children,
  proxy,
}: {
  href?: string;
  children?: React.ReactNode;
  proxy: MarkdownProxy;
}): React.ReactElement {
  const setupLink = parseSetupLinkHref(href);
  if (setupLink) {
    return (
      <SetupLinkButton kind={setupLink.kind} token={setupLink.token}>
        {children}
      </SetupLinkButton>
    );
  }

  const resolvedHref = proxy(href) ?? href ?? '#';
  const isHash = resolvedHref.startsWith('#');
  const isExternal = !isInternalUrl(resolvedHref);
  const newTab = isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {};

  // Markdown can contain arbitrary same-origin absolute URLs. Next.js treats
  // those as app routes and prefetches them, including typos such as
  // `/legal/terms.`, and a malformed absolute href (`http://:`) crashes its
  // prefetch path. Only trusted root-relative/hash paths belong in the app
  // router; every other href stays a plain anchor.
  if (!shouldUseNextLink(resolvedHref)) {
    return (
      <a href={resolvedHref} className={INLINE_LINK_CLASS} {...newTab}>
        <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
      </a>
    );
  }

  return (
    <Link
      href={resolvedHref}
      onClick={isHash ? (e) => handleHashClick(e, resolvedHref) : undefined}
      className={INLINE_LINK_CLASS}
      {...newTab}
    >
      <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
    </Link>
  );
}

/**
 * Classifies every link of a standalone block against its PROXIED href.
 * Returns `null` — render the block as text — when the list is empty or any
 * one link is not an action. `origin` is `window.location.origin`, or `null`
 * on the server.
 */
export function resolveActionBlock(
  links: ReadonlyArray<{ href: string; text: string }>,
  proxy: MarkdownProxy,
  origin: string | null,
): MarkdownActionLink[] | null {
  if (links.length === 0) return null;
  const actions: MarkdownActionLink[] = [];
  for (const link of links) {
    const resolved = proxy(link.href) ?? link.href;
    const action = classifyMarkdownActionLink(resolved, link.text, origin);
    if (!action) return null;
    actions.push(action);
  }
  return actions;
}

function noopSubscribe(): () => void {
  return noop;
}

/**
 * The page origin, hydration-safe. The server snapshot is `null`, and React
 * also uses it for the hydration render, so server and client first classify
 * with the same origin. The client re-renders with the real origin after
 * hydration. Reading `window` directly here made a same-origin absolute link
 * server-render as an external chip and hydrate as an internal one.
 */
function useHydrationSafeOrigin(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => null,
  );
}

function ActionBlockOrFallback({
  node,
  proxy,
  fallback,
}: {
  node: unknown;
  proxy: MarkdownProxy;
  fallback: React.ReactElement;
}): React.ReactElement {
  const origin = useHydrationSafeOrigin();
  const links = standaloneActionLinks(node);
  const actions = links && resolveActionBlock(links, proxy, origin);
  return actions ? <MarkdownActionBlock actions={actions} /> : fallback;
}

/**
 * The `p` / `h1`–`h6` hook-in: the action block when `node` is a standalone
 * action block, otherwise `fallback` unchanged. A plain function (the
 * renderers call it from the components map), so it returns an element whose
 * component reads the origin through a hook.
 */
export function withActionBlock(
  node: unknown,
  proxy: MarkdownProxy,
  fallback: React.ReactElement,
): React.ReactElement {
  return <ActionBlockOrFallback node={node} proxy={proxy} fallback={fallback} />;
}

function noop(): void {}

/**
 * A raw provider connect URL, rendered as the same card a minted setup link
 * uses — so the two look identical in a transcript. `action.intent: 'link'`
 * makes the card's button a new-tab link instead of a modal trigger.
 */
function ConnectActionCard({ action }: { action: MarkdownActionLink }): React.ReactElement {
  const copy = useLocalizedUiCatalog(COPY);
  const outcome = useMemo<Outcome>(
    () => ({
      id: `connect:${action.href}`,
      kind: 'external',
      title: action.label,
      description: '',
      status: { label: copy.opensInNewTab, tone: 'neutral' },
      at: 0,
      meta: action.host ? [action.host] : [],
      action: { label: copy.connect, intent: 'link', href: action.href },
      resourceHref: null,
    }),
    [action.href, action.label, action.host, copy.opensInNewTab, copy.connect],
  );

  return (
    <OutcomeCard
      outcome={outcome}
      index={0}
      icon={PlugIcon}
      actionVariant="default"
      onOpen={noop}
      className="my-2"
    />
  );
}

const CHIP_CLASS = 'max-w-full active:scale-[0.96]';
const CHIP_ICON_CLASS = 'size-3.5 shrink-0';

function InternalActionChip({ action }: { action: MarkdownActionLink }): React.ReactElement {
  const Glyph = ACTION_ICON[action.icon];
  const trailing = action.icon === 'arrow-right';
  const content = (
    <>
      {trailing ? null : <Glyph aria-hidden="true" className={CHIP_ICON_CLASS} />}
      <span className="min-w-0 truncate">{action.label}</span>
      {trailing ? <Glyph aria-hidden="true" className={CHIP_ICON_CLASS} /> : null}
    </>
  );

  return (
    <Button asChild variant="outline" size="sm" className={CHIP_CLASS}>
      {shouldUseNextLink(action.href) ? (
        <Link href={action.href}>{content}</Link>
      ) : (
        <a href={action.href}>{content}</a>
      )}
    </Button>
  );
}

function ExternalActionChip({ action }: { action: MarkdownActionLink }): React.ReactElement {
  const copy = useLocalizedUiCatalog(COPY);
  const LeadingGlyph = action.icon === 'search' ? MagnifyingGlassIcon : null;

  const chip = (
    <Button asChild variant="outline" size="sm" className={CHIP_CLASS}>
      <a
        href={action.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${action.label} ${copy.opensInNewTabSuffix}`}
      >
        {LeadingGlyph ? <LeadingGlyph aria-hidden="true" className={CHIP_ICON_CLASS} /> : null}
        <span className="min-w-0 truncate">{action.label}</span>
        <ArrowUpRightIcon aria-hidden="true" className={CHIP_ICON_CLASS} />
      </a>
    </Button>
  );

  // The destination host, visible before the click — the chip shows only the label.
  return action.host ? (
    <Hint label={action.host} side="top">
      {chip}
    </Hint>
  ) : (
    chip
  );
}

function ActionCard({ action }: { action: MarkdownActionLink }): React.ReactElement | null {
  if (action.kind === 'setup') {
    const setupLink = parseSetupLinkHref(action.href);
    if (!setupLink) return null;
    return (
      <SetupLinkButton kind={setupLink.kind} token={setupLink.token}>
        {action.label}
      </SetupLinkButton>
    );
  }
  return <ConnectActionCard action={action} />;
}

function ActionChip({ action }: { action: MarkdownActionLink }): React.ReactElement {
  return action.kind === 'external' ? (
    <ExternalActionChip action={action} />
  ) : (
    <InternalActionChip action={action} />
  );
}

/**
 * Renders a resolved action block. Cards (`setup`, `connect`) stack; chips
 * (`internal`, `external`) wrap in one row. A mixed block renders every card
 * first, then the chip row, inside one `space-y-2` wrapper.
 *
 * No enter animation: this is transcript content, seen constantly.
 */
export function MarkdownActionBlock({
  actions,
}: {
  actions: ReadonlyArray<MarkdownActionLink>;
}): React.ReactElement {
  const cards = actions.filter((a) => a.kind === 'setup' || a.kind === 'connect');
  const chips = actions.filter((a) => a.kind === 'internal' || a.kind === 'external');

  // Chip-only: the row owns the block margins. Mixed: the outer wrapper owns them.
  const chipRow =
    chips.length > 0 ? (
      <div
        className={cn('flex flex-wrap gap-2', cards.length === 0 && 'my-4 first:mt-0 last:mb-0')}
      >
        {chips.map((action, i) => (
          <ActionChip key={`${i}:${action.href}`} action={action} />
        ))}
      </div>
    ) : null;

  if (cards.length === 0) return <>{chipRow}</>;

  return (
    <div className="my-4 space-y-2 first:mt-0 last:mb-0">
      {cards.map((action, i) => (
        <ActionCard key={`${i}:${action.href}`} action={action} />
      ))}
      {chipRow}
    </div>
  );
}
