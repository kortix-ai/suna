'use client';

/**
 * The views of a tab that holds several (Capabilities, Access) as a rail
 * left of the content: one row per view, its glyph, its name and its grant
 * ("All but 2", "4 of 9"). The selected row is filled. Below `md` the rail
 * hides and the tab bar's pills take over, so a narrow window keeps the full
 * width for the content.
 *
 *   Tools        All but 2 │ Tools                    [All|Specific|None]
 *   Skills          4 of 9 │ …
 */

import type { ReactNode } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { UiLink as Link } from '../../providers/ui-provider';
import { SECTION_ICON } from './agent-overview';
import { type AgentTabGroup, useInPageNavigate } from './agent-page-chrome';
import type { AgentRailKey } from './agent-tabs';

/** The group a rail draws: the one holding `active`, when it has several views. */
export function railGroupOf(groups: AgentTabGroup[], active: AgentRailKey): AgentTabGroup | null {
  const group = groups.find((g) => g.items.some((item) => item.key === active));
  return group && group.items.length > 1 ? group : null;
}

export function AgentSectionRail({
  group,
  active,
  dirty,
  children,
}: {
  group: AgentTabGroup | null;
  active: AgentRailKey;
  dirty?: readonly AgentRailKey[];
  children: ReactNode;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const go = useInPageNavigate();
  if (!group) return <>{children}</>;
  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label={group.label} className="hidden w-56 shrink-0 flex-col gap-0.5 pt-5 pl-8 md:flex">
        {group.items.map((item) => {
          const on = item.key === active;
          const Icon = item.key in SECTION_ICON ? SECTION_ICON[item.key as keyof typeof SECTION_ICON] : null;
          return (
            <Link
              key={item.key}
              href={item.href}
              prefetch={false}
              onClick={(e) => go(e, item.href)}
              aria-current={on ? 'page' : undefined}
              data-testid={`agent-rail-${item.key}`}
              className={cn(
                'flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-fast',
                on ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
              )}
            >
              {Icon ? <Icon className="size-4 shrink-0" /> : null}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {dirty?.includes(item.key) ? (
                <span role="img" aria-label={t('unsavedTab')} className="bg-foreground size-1.5 shrink-0 rounded-full" />
              ) : null}
              {item.count !== undefined ? (
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{item.count}</span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:pl-3">{children}</div>
    </div>
  );
}
