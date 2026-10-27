'use client';

/**
 * One look for every view of the agent page's Access tab (Marko, 2026-10-27:
 * "top notch unified UX; built-in stuff more lowkey than the project's").
 *
 *   lead line ............................ Manage
 *   Kortix can use [All ▾]  what the mode means
 *   ┌ the project's items, one row each ┐
 *   › Built-in · 9 of 12   (a quiet fold, after the project's items)
 *
 * Every row is the same: name, one muted line, an exception mark, a switch.
 * Skills, Tools, Extensions, Connectors, Secrets and Apps draw from here, so
 * a change to the row changes every view.
 */

import type { AgentGrantSetV2 } from '@kortix/sdk';
import { CaretRightIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import { Switch } from '../../primitives/switch';
import { EditorList } from '../sections/view/agent-editor-primitives';

export interface AccessItem {
  id: string;
  /** Defaults to the id, in mono: most items are names a person types. */
  title?: ReactNode;
  /** A real logo only (a connector's app mark). */
  leading?: ReactNode;
  /** One line. The whole text shows on hover. */
  description?: ReactNode;
  /** An exception only (Needs auth, Not set). The normal state carries none. */
  status?: ReactNode;
  /** Absent: the row has no switch (an always-on extension). */
  checked?: boolean;
  onCheckedChange?: (on: boolean) => void;
  disabled?: boolean;
}

/** The view's one muted line and its one action, at the right edge. */
export function AccessLead({ description, action }: { description: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground min-w-0 text-sm text-pretty sm:max-w-xl">{description}</p>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}

export function AccessList({ items, quiet = false }: { items: AccessItem[]; quiet?: boolean }) {
  const t = useI18nTranslations('agentCapabilities');
  return (
    <EditorList>
      {items.map((item) => (
        <li
          key={item.id}
          data-capability={item.id}
          className={cn('flex min-h-12 items-center gap-3 px-4 py-2', item.disabled && 'opacity-60')}
        >
          {item.leading}
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate text-sm',
                item.title === undefined && 'font-mono',
                quiet ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {item.title ?? item.id}
            </span>
            {item.description ? (
              <span
                className="text-muted-foreground block truncate text-xs"
                title={typeof item.description === 'string' ? item.description : undefined}
              >
                {item.description}
              </span>
            ) : null}
          </span>
          {item.status ? <span className="flex shrink-0 items-center gap-2">{item.status}</span> : null}
          {item.onCheckedChange ? (
            <Switch
              checked={item.checked ?? false}
              disabled={item.disabled}
              onCheckedChange={item.onCheckedChange}
              aria-label={t('toggle', { name: item.id })}
            />
          ) : null}
        </li>
      ))}
    </EditorList>
  );
}

/** The project's own items: the first thing a view shows. */
export function AccessGroup({ title, items, empty }: { title: string; items: AccessItem[]; empty?: string }) {
  return (
    <section className="space-y-3">
      <h3 className="text-foreground text-sm font-medium">{title}</h3>
      {items.length > 0 ? (
        <AccessList items={items} />
      ) : empty ? (
        <p className="text-muted-foreground text-sm text-pretty">{empty}</p>
      ) : null}
    </section>
  );
}

/**
 * What Kortix ships, after the project's items and folded: open by default
 * only when the project has none of its own, so the view is never empty.
 */
export function BuiltinGroup({ items, defaultOpen }: { items: AccessItem[]; defaultOpen: boolean }) {
  const t = useI18nTranslations('agentCapabilities');
  if (items.length === 0) return null;
  const switchable = items.filter((item) => item.onCheckedChange);
  const on = switchable.filter((item) => item.checked).length;
  return (
    <Disclosure defaultOpen={defaultOpen} className="group/builtin space-y-3">
      <DisclosureTrigger>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-1.5 rounded-sm text-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          <CaretRightIcon aria-hidden className="size-3.5 shrink-0 group-data-[state=open]/builtin:rotate-90" />
          {t('groups.builtin')}
          {switchable.length > 0 ? (
            <span className="tabular-nums">{t('builtinOn', { on, total: switchable.length })}</span>
          ) : null}
        </button>
      </DisclosureTrigger>
      <DisclosureContent>
        <AccessList items={items} quiet />
      </DisclosureContent>
    </Disclosure>
  );
}

/**
 * One switch over a plain grant (connectors, secrets, Apps): All reads every
 * row on, and turning one off under All keeps every other id, so the grant
 * becomes Specific instead of losing the rest. The last one off is None.
 */
export function plainGrantSwitch(
  value: AgentGrantSetV2 | undefined,
  ids: readonly string[],
  onChange: (next: AgentGrantSetV2) => void,
) {
  const picked = value === 'all' ? [...ids] : Array.isArray(value) ? value : [];
  return (id: string): Pick<AccessItem, 'checked' | 'onCheckedChange'> => ({
    checked: value === 'all' || picked.includes(id),
    onCheckedChange: (on) => {
      const next = on ? [...picked.filter((x) => x !== id), id] : picked.filter((x) => x !== id);
      onChange(next.length > 0 ? next : 'none');
    },
  });
}
