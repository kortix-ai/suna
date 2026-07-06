'use client';

/**
 * All · Pick · None — the one governance grant-mode machine, parameterized so
 * both a flat checklist (skills/connectors/secrets) and a grouped catalog
 * (kortix_cli) share the same state transitions instead of re-implementing
 * them twice.
 */

import { Segmented } from './agent-editor-primitives';
import { KORTIX_CLI_CATALOG } from './agent-editor-catalog';
import { cn } from '@/lib/utils';
import type { AgentGrantSetV2 } from '@kortix/sdk/projects-client';
import { useState } from 'react';

type GrantMode = 'all' | 'pick' | 'none';

function GrantModeField({
  value,
  onChange,
  allLabel,
  noneLabel,
  children,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  allLabel: string;
  noneLabel: string;
  children: (ctx: { selected: Set<string>; toggle: (id: string) => void }) => React.ReactNode;
}) {
  const mode: GrantMode =
    value === 'all' ? 'all' : value === 'none' || value === undefined ? 'none' : 'pick';
  const [wantPick, setWantPick] = useState(Array.isArray(value) && value.length > 0);
  const effectiveMode: GrantMode =
    value === 'all' ? 'all' : Array.isArray(value) && (value.length > 0 || wantPick) ? 'pick' : mode;
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
        <Segmented
          options={[
            { value: 'all', label: 'All' },
            { value: 'pick', label: 'Pick' },
            { value: 'none', label: 'None' },
          ]}
          value={effectiveMode}
          onChange={(m) => m && pick(m)}
        />
        {effectiveMode === 'all' && (
          <span className="text-muted-foreground/60 text-[11px]">{allLabel}</span>
        )}
        {effectiveMode === 'none' && (
          <span className="text-muted-foreground/60 text-[11px]">{noneLabel}</span>
        )}
      </div>
      {effectiveMode === 'pick' ? children({ selected, toggle }) : null}
    </div>
  );
}

/** All · Pick · None, with a checklist of the project's declared items when
 *  in Pick mode. The one governance control reused for skills/connectors/secrets. */
export function GrantSetField({
  value,
  onChange,
  options,
  emptyLabel,
  allLabel,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  options: { id: string; label: string }[];
  emptyLabel: string;
  allLabel: string;
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
        const orphans = [...selected].filter((id) => !optionIds.has(id)).map((id) => ({ id, label: id }));
        const rows = [...options, ...orphans];
        return rows.length === 0 ? (
          <p className="text-muted-foreground/60 text-[11px]">{emptyLabel}</p>
        ) : (
          <div className="border-border/60 max-h-40 overflow-y-auto rounded-md border p-1">
            {rows.map((o) => {
              const isSel = selected.has(o.id);
              const isOrphan = !optionIds.has(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => toggle(o.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-[color,background-color,transform] active:scale-[0.96]',
                    isSel ? 'bg-secondary' : 'hover:bg-muted/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border text-[9px]',
                      isSel ? 'border-foreground bg-foreground text-background' : 'border-border/70',
                    )}
                  >
                    {isSel ? '✓' : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{o.label}</span>
                  {isOrphan && <span className="text-kortix-orange">missing</span>}
                </button>
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
      allLabel="Every Kortix-CLI power the launcher holds."
      noneLabel="No Kortix-CLI powers."
    >
      {({ selected, toggle }) => (
        <div className="border-border/60 max-h-56 space-y-2 overflow-y-auto rounded-md border p-2">
          {KORTIX_CLI_CATALOG.map((grp) => (
            <div key={grp.group} className="space-y-1">
              <p className="text-muted-foreground/70 text-[10px] font-medium tracking-wide uppercase">
                {grp.group}
              </p>
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
                        'rounded px-1.5 py-1 font-mono text-[11px] transition-[color,background-color,transform] active:scale-[0.96]',
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
