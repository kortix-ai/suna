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

import { CaretRightIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import { Switch } from '../../primitives/switch';
import { EditorList } from '../sections/view/agent-editor-primitives';
import { useCapabilityShellEmbed } from './capability-page-shell';

export { plainGrantSwitch } from './agent-resource-scope';

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
  /** The row's rule beside its switch, in the agent page's rail layout: Ask, Allow, a policy set. */
  control?: ReactNode;
  /** Opens the item (a skill's files, a connector's page): the name becomes a link-like button. */
  onOpen?: () => void;
  /** Absent: the row has no switch (an always-on extension). */
  checked?: boolean;
  onCheckedChange?: (on: boolean) => void;
  disabled?: boolean;
}

/** A one-line description reads as text: Markdown code ticks (a skill's routing text) are dropped. */
const plain = (text: string) => text.replace(/`([^`]*)`/g, '$1');

function AccessText({ item, quiet }: { item: AccessItem; quiet: boolean }) {
  return (
    <>
      {/* The id is mono at normal tracking: the global `.font-mono` rule pulls it
          to -0.025em and a 1.2 line height, which crowds a name and squeezes the
          line under it. The block keeps the body line box (`leading-5`). */}
      <span
        className={cn(
          'block truncate text-sm leading-5 underline-offset-4 group-hover/open:underline',
          quiet ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {item.title ?? <span className="font-mono !tracking-normal">{item.id}</span>}
      </span>
      {item.description ? (
        <span
          className="text-muted-foreground mt-1 block truncate text-xs"
          title={typeof item.description === 'string' ? plain(item.description) : undefined}
        >
          {typeof item.description === 'string' ? plain(item.description) : item.description}
        </span>
      ) : null}
    </>
  );
}

/**
 * The agent page's rail layout: one filled, bordered card, a divider between rows; a row that is
 * switched off reads muted; the row's rule sits left of its switch.
 */
function CardAccessList({ items }: { items: AccessItem[] }) {
  const t = useI18nTranslations('agentCapabilities');
  return (
    <ul className="bg-popover divide-border divide-y overflow-hidden rounded-lg border">
      {items.map((item) => {
        const off = item.onCheckedChange !== undefined && !item.checked;
        return (
          <li
            key={item.id}
            data-capability={item.id}
            className={cn('flex min-h-12 items-center gap-3 px-4 py-2.5', item.disabled && 'opacity-60')}
          >
            {item.leading}
            {item.onOpen ? (
              <button
                type="button"
                onClick={item.onOpen}
                className="group/open focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <AccessText item={item} quiet={off} />
              </button>
            ) : (
              <span className="min-w-0 flex-1">
                <AccessText item={item} quiet={off} />
              </span>
            )}
            {item.status ? <span className="flex shrink-0 items-center gap-2">{item.status}</span> : null}
            {item.control !== undefined ? (
              <span className="text-muted-foreground flex shrink-0 justify-end text-xs">{item.control}</span>
            ) : null}
            {item.onCheckedChange ? (
              <Switch
                checked={item.checked ?? false}
                disabled={item.disabled}
                onCheckedChange={item.onCheckedChange}
                aria-label={t('toggle', { name: typeof item.title === 'string' ? item.title : item.id })}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function AccessList({ items, quiet = false }: { items: AccessItem[]; quiet?: boolean }) {
  const t = useI18nTranslations('agentCapabilities');
  const embed = useCapabilityShellEmbed();
  if (embed?.titled) return <CardAccessList items={items} />;
  return (
    <EditorList>
      {items.map((item) => (
        <li
          key={item.id}
          data-capability={item.id}
          className={cn('flex min-h-12 items-center gap-3 px-4 py-2', item.disabled && 'opacity-60')}
        >
          {item.leading}
          {item.onOpen ? (
            <button
              type="button"
              onClick={item.onOpen}
              className="group/open focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
            >
              <AccessText item={item} quiet={quiet} />
            </button>
          ) : (
            <span className="min-w-0 flex-1">
              <AccessText item={item} quiet={quiet} />
            </span>
          )}
          {item.status ? <span className="flex shrink-0 items-center gap-2">{item.status}</span> : null}
          {item.onCheckedChange ? (
            <Switch
              checked={item.checked ?? false}
              disabled={item.disabled}
              onCheckedChange={item.onCheckedChange}
              aria-label={t('toggle', { name: typeof item.title === 'string' ? item.title : item.id })}
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
