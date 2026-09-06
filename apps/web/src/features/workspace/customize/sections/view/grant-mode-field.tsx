'use client';

/**
 * All · Pick · None — the one governance grant-mode machine, parameterized so
 * both a flat checklist (skills/connectors/secrets) and a grouped catalog
 * (kortix_cli) share the same state transitions instead of re-implementing
 * them twice.
 */

import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { AgentGrantSetV2 } from '@kortix/sdk';
import { CheckIcon } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import { KORTIX_CLI_CATALOG } from './agent-editor-catalog';

export type GrantMode = 'all' | 'pick' | 'none';

/** Summarize a grant set — "All", "None", "3 picked" — for a card header. */
export function grantSummary(v: AgentGrantSetV2 | undefined): {
  label: string;
  tone: 'muted' | 'outline';
} {
  if (v === 'all') return { label: 'All', tone: 'outline' };
  if (v === undefined || v === 'none' || (Array.isArray(v) && v.length === 0))
    return { label: 'None', tone: 'muted' };
  return { label: `${(v as string[]).length} picked`, tone: 'outline' };
}

const GRANT_MODES: { value: GrantMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pick', label: 'Pick' },
  { value: 'none', label: 'None' },
];

export function GrantModeField({
  value,
  onChange,
  allLabel,
  noneLabel,
  alwaysRender = false,
  children,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  allLabel: string;
  noneLabel: string;
  /** Render `children` in every mode, not only Pick — for a catalog that
   *  stays on screen and shows each card as included / excluded. */
  alwaysRender?: boolean;
  children: (ctx: {
    selected: Set<string>;
    toggle: (id: string) => void;
    mode: GrantMode;
  }) => React.ReactNode;
}) {
  const mode: GrantMode =
    value === 'all' ? 'all' : value === 'none' || value === undefined ? 'none' : 'pick';
  const [wantPick, setWantPick] = useState(() => Array.isArray(value) && value.length > 0);
  const effectiveMode: GrantMode =
    value === 'all'
      ? 'all'
      : Array.isArray(value) && (value.length > 0 || wantPick)
        ? 'pick'
        : mode;
  const selected = new Set(Array.isArray(value) ? value : []);

  const pick = (m: GrantMode) => {
    setWantPick(m === 'pick');
    if (m === 'all') return onChange('all');
    if (m === 'none') return onChange('none');
    onChange(Array.isArray(value) ? value : []);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={effectiveMode} onValueChange={(m) => pick(m as GrantMode)} className="w-fit">
          <TabsListCompact type="default" aria-label="Grant mode">
            {GRANT_MODES.map((m) => (
              <TabsTriggerCompact key={m.value} value={m.value}>
                {m.label}
              </TabsTriggerCompact>
            ))}
          </TabsListCompact>
        </Tabs>
        {effectiveMode === 'all' && (
          <span className="text-muted-foreground text-xs">{allLabel}</span>
        )}
        {effectiveMode === 'none' && (
          <span className="text-muted-foreground text-xs">{noneLabel}</span>
        )}
      </div>
      {effectiveMode === 'pick' || alwaysRender
        ? children({ selected, toggle, mode: effectiveMode })
        : null}
    </div>
  );
}

/** All · Pick · None, with a checklist of the project's declared items when
 *  in Pick mode. The one governance control reused for skills/connectors/secrets. */
/** One pickable row: the id the grant stores, and what a person needs to
 *  recognise it — a name, a second line, a status chip. */
export interface GrantOption {
  id: string;
  label: string;
  /** A second line under the label — a skill's description, a connector's
   *  slug, a secret's purpose. */
  description?: string;
  /** At the row's right edge — a `Badge` for a connector that needs auth. */
  trailing?: ReactNode;
}

export function GrantSetField({
  value,
  onChange,
  options,
  emptyLabel,
  allLabel,
  rowAccessory,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  options: GrantOption[];
  emptyLabel: string;
  allLabel: string;
  /** Optional control rendered BESIDE each granted row (e.g. the connectors
   *  field's "personal" toggle). The row itself is a `<button>`, so an
   *  interactive accessory cannot be nested inside it — when this returns a
   *  node the row is wrapped in a flex container and the accessory becomes a
   *  sibling. Fields that pass nothing render exactly as before. */
  rowAccessory?: (id: string, isSelected: boolean) => ReactNode;
}) {
  return (
    <GrantModeField
      value={value}
      onChange={onChange}
      allLabel={allLabel}
      noneLabel="Deny — nothing granted."
    >
      {({ selected, toggle }) => {
        const optionIds = new Set(options.map((o) => o.id));
        const orphans: GrantOption[] = [];
        for (const id of selected) {
          if (!optionIds.has(id)) orphans.push({ id, label: id });
        }
        const rows = [...options, ...orphans];
        return rows.length === 0 ? (
          <p className="text-muted-foreground text-xs">{emptyLabel}</p>
        ) : (
          <div className="border-border/60 max-h-80 overflow-y-auto rounded-md border p-1">
            {rows.map((o) => {
              const isSel = selected.has(o.id);
              const isOrphan = !optionIds.has(o.id);
              const accessory = rowAccessory?.(o.id, isSel);
              const row = (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => toggle(o.id)}
                  className={cn(
                    'flex items-center gap-2.5 rounded px-2 text-left text-xs transition-[color,background-color,transform] active:scale-[0.98]',
                    o.description ? 'py-2' : 'py-1.5',
                    accessory ? 'min-w-0 flex-1' : 'w-full',
                    isSel ? 'bg-secondary' : 'hover:bg-muted/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                      isSel
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border/70',
                    )}
                  >
                    {isSel ? <CheckIcon className="size-2.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono">{o.label}</span>
                    {o.description ? (
                      <span className="text-muted-foreground block truncate text-xs leading-4">
                        {o.description}
                      </span>
                    ) : null}
                  </span>
                  {o.trailing ? <span className="shrink-0">{o.trailing}</span> : null}
                  {isOrphan && <span className="text-kortix-orange shrink-0">missing</span>}
                </button>
              );
              return accessory ? (
                <div key={o.id} className="flex items-center gap-1">
                  {row}
                  {accessory}
                </div>
              ) : (
                row
              );
            })}
          </div>
        );
      }}
    </GrantModeField>
  );
}

/** All · Pick · None over the grouped grantable CLI action catalog. */
export function KortixCliField({
  value,
  onChange,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
}) {
  return (
    <GrantModeField
      value={value}
      onChange={onChange}
      allLabel="Everything the person who started the session can do."
      noneLabel="Deny — nothing granted."
    >
      {({ selected, toggle }) => (
        <div className="border-border/60 max-h-64 space-y-3 overflow-y-auto rounded-md border p-2.5">
          {KORTIX_CLI_CATALOG.map((grp) => (
            <div key={grp.group} className="space-y-1.5">
              <p className="text-muted-foreground text-xs font-medium">{grp.group}</p>
              <div className="flex flex-wrap gap-1">
                {grp.actions.map((action) => {
                  const isSel = selected.has(action);
                  return (
                    <button
                      key={action}
                      type="button"
                      aria-pressed={isSel}
                      onClick={() => toggle(action)}
                      className={cn(
                        'rounded px-1.5 py-1 font-mono text-xs transition-[color,background-color,transform] active:scale-[0.96]',
                        isSel
                          ? 'bg-foreground text-background'
                          : 'bg-muted/40 text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {action.replace(/^project\./, '')}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </GrantModeField>
  );
}
