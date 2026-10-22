'use client';

/**
 * PROTOTYPE — throwaway. Answers one question: what replaces the agent page's
 * left rail? Rendered on the real agent page, switched with `?variant=`:
 *
 *   rail     — today's left rail (the baseline; no param)
 *   tabs     — grouped underline tabs under the header, no rail
 *   groups   — General / Access / Runtime switch + that group's tabs
 *   inline   — vertical tabs beside the content column, each with its value
 *
 * Read-only navigation over the same `?section=` links; nothing here mutates.
 * Once a variant wins, fold it into `agent-page.tsx` properly and delete this
 * file and the switcher. Dev builds only (`PROTOTYPE_ENABLED`).
 */

import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { type ReactNode, useCallback, useEffect } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import {
  UiLink as Link,
  useUiPathname as usePathname,
  useUiRouter as useRouter,
  useUiSearchParams as useSearchParams,
} from '../../providers/ui-provider';

export const PROTOTYPE_ENABLED = process.env.NODE_ENV !== 'production';

export const NAV_VARIANTS = [{ key: 'rail' }, { key: 'tabs' }, { key: 'groups' }, { key: 'inline' }] as const;
export type NavVariant = (typeof NAV_VARIANTS)[number]['key'];

export function useNavVariant(): NavVariant {
  const raw = useSearchParams().get('variant');
  if (!PROTOTYPE_ENABLED) return 'rail';
  return NAV_VARIANTS.some((v) => v.key === raw) ? (raw as NavVariant) : 'rail';
}

export interface NavItem {
  key: string;
  label: string;
  group: string;
}

interface NavProps {
  groups: { group: string; items: NavItem[] }[];
  section: string;
  href: (key: string) => string;
  /** The current value per topic — "All", "2 picked", the model name. */
  summaries?: Partial<Record<string, string>>;
}

/** `?section=` link that keeps `?variant=` so switching topics stays in the variant. */
function useVariantHref(href: (key: string) => string) {
  const variant = useSearchParams().get('variant');
  return (key: string) => (variant ? `${href(key)}&variant=${variant}` : href(key));
}

// ─── tabs: grouped underline tabs ──────────────────────────────────────────

export function GroupedUnderlineTabs({ groups, section, href }: NavProps) {
  const to = useVariantHref(href);
  return (
    <nav className="border-border/60 flex shrink-0 items-end gap-8 overflow-x-auto border-b px-5 pt-1">
      {groups.map((g) => (
        <div key={g.group} className="flex shrink-0 flex-col gap-1">
          <span className="text-muted-foreground px-2 text-xs">{g.group}</span>
          <Tabs value={section}>
            <TabsList type="underline" className="h-auto gap-1 border-b-0">
              {g.items.map((item) => (
                <TabsTrigger key={item.key} value={item.key} asChild className="w-fit flex-none px-2">
                  <Link href={to(item.key)} prefetch>
                    {item.label}
                  </Link>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      ))}
    </nav>
  );
}

// ─── groups: group switch + sub tabs ───────────────────────────────────────

export function GroupSwitchTabs({ groups, section, href }: NavProps) {
  const to = useVariantHref(href);
  const active = groups.find((g) => g.items.some((i) => i.key === section)) ?? groups[0];
  return (
    <nav className="border-border/60 flex shrink-0 items-center gap-5 overflow-x-auto border-b px-5 py-2">
      <Tabs value={active?.group}>
        <TabsList>
          {groups.map((g) => (
            <TabsTrigger key={g.group} value={g.group} asChild className="w-fit flex-none">
              <Link href={to(g.items[0].key)} prefetch>
                {g.group}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Tabs value={section}>
        <TabsList type="underline" className="h-auto gap-1 border-b-0">
          {active?.items.map((item) => (
            <TabsTrigger key={item.key} value={item.key} asChild className="w-fit flex-none px-2">
              <Link href={to(item.key)} prefetch>
                {item.label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </nav>
  );
}

// ─── inline: vertical tabs beside the content, with values ────────────────

export function InlineVerticalTabs({
  groups,
  section,
  href,
  summaries,
  children,
}: NavProps & { children: ReactNode }) {
  const to = useVariantHref(href);
  return (
    <div className="mx-auto flex w-full max-w-5xl items-start gap-14 px-4 py-10 pb-32 lg:py-14">
      <nav className="sticky top-0 flex w-52 shrink-0 flex-col gap-4">
        {groups.map((g) => (
          <div key={g.group} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground px-2.5 pb-1 text-xs">{g.group}</span>
            {g.items.map((item) => {
              const isActive = item.key === section;
              return (
                <Link
                  key={item.key}
                  href={to(item.key)}
                  prefetch
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm transition-none',
                    isActive
                      ? 'bg-active text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                  )}
                >
                  <span className="truncate">{item.label}</span>
                  {summaries?.[item.key] ? (
                    <span className="text-muted-foreground shrink-0 text-xs font-normal tabular-nums">
                      {summaries[item.key]}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="min-w-0 max-w-2xl flex-1">{children}</div>
    </div>
  );
}

// ─── the floating switcher ────────────────────────────────────────────────

export function PrototypeSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const current = useNavVariant();
  const t = useTranslations('agentNavPrototype');
  const labels: Record<NavVariant, string> = {
    rail: t('variantRail'),
    tabs: t('variantTabs'),
    groups: t('variantGroups'),
    inline: t('variantInline'),
  };
  const index = NAV_VARIANTS.findIndex((v) => v.key === current);

  const go = useCallback(
    (step: number) => {
      const next = NAV_VARIANTS[(index + step + NAV_VARIANTS.length) % NAV_VARIANTS.length];
      const params = new URLSearchParams(search.toString());
      if (next.key === 'rail') params.delete('variant');
      else params.set('variant', next.key);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [index, pathname, router, search],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  if (!PROTOTYPE_ENABLED) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center">
      <div className="bg-foreground text-background pointer-events-auto flex items-center gap-1 rounded-full p-1 shadow-lg">
        <button
          type="button"
          aria-label={t('previousVariant')}
          onClick={() => go(-1)}
          className="flex size-7 items-center justify-center rounded-full hover:bg-background/15"
        >
          <CaretLeftIcon className="size-3.5" />
        </button>
        <span className="min-w-56 px-2 text-center text-xs tabular-nums">
          {String.fromCharCode(65 + index)} · {labels[NAV_VARIANTS[index].key]}
        </span>
        <button
          type="button"
          aria-label={t('nextVariant')}
          onClick={() => go(1)}
          className="flex size-7 items-center justify-center rounded-full hover:bg-background/15"
        >
          <CaretRightIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
