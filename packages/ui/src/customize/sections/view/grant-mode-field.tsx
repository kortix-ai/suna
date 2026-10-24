'use client';

import type { UiTranslator } from '../../../i18n';
import { useTranslations as useI18nTranslations } from '../../../i18n';
/**
 * All · Pick · None — the one governance grant-mode machine, parameterized so
 * both a flat checklist (skills/connectors/secrets) and a grouped catalog
 * (kortix_permissions) share the same state transitions instead of re-implementing
 * them twice.
 */

import { Tabs, TabsList, TabsTrigger } from '../../../primitives/tabs';
import { Badge } from '../../../primitives/badge';
import { Checkbox } from '../../../primitives/checkbox';
import type { AgentGrantSetV2 } from '@kortix/sdk';
import { type ReactNode, useState } from 'react';
import { KORTIX_PERMISSIONS_CATALOG } from './agent-editor-catalog';
import { useUiParams } from '../../../providers/ui-provider';
import { useProjectFeatureFlags } from '../../../internal/lib/use-project-feature-flags';

export type GrantMode = 'all' | 'pick' | 'none';

/** Summarize a grant set — "All", "None", "3 picked" — for a card header. */
export function grantSummary(
  v: AgentGrantSetV2 | undefined,
  tI18nComplete?: UiTranslator,
): {
  label: string;
  tone: 'muted' | 'outline';
} {
  if (v === 'all')
    return { label: tI18nComplete?.raw('texta52ace420f21') ?? 'All', tone: 'outline' };
  if (v === undefined || v === 'none' || (Array.isArray(v) && v.length === 0))
    return { label: tI18nComplete?.raw('textdc937b598926') ?? 'None', tone: 'muted' };
  return {
    label:
      tI18nComplete?.('text8b168cb79501', { value0: (v as string[]).length }) ??
      `${(v as string[]).length} picked`,
    tone: 'outline',
  };
}

const GRANT_MODES: { value: GrantMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pick', label: 'Pick' },
  { value: 'none', label: 'None' },
];

export function GrantModeField({
  value,
  onChange,
  alwaysRender = false,
  children,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  /** Render `children` in every mode, not only Pick — for a catalog that
   *  stays on screen and shows each card as included / excluded. */
  alwaysRender?: boolean;
  children: (ctx: {
    selected: Set<string>;
    toggle: (id: string) => void;
    mode: GrantMode;
  }) => React.ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
    <div className="space-y-3">
      {/* The segmented control alone (Jay, 2026-10-20): the list below shows
          what each mode means, so no label or help line sits beside it. */}
      <Tabs value={effectiveMode} onValueChange={(m) => pick(m as GrantMode)}>
        <TabsList aria-label={tI18nComplete.raw('text74009e6664f5')}>
          {GRANT_MODES.map((m) => (
            <TabsTrigger key={m.value} value={m.value}>
              {m.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
  rowAccessory,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  options: GrantOption[];
  emptyLabel: string;
  /** Optional control rendered BESIDE each granted row (e.g. the connectors
   *  field's "personal" toggle). The row itself is a `<button>`, so an
   *  interactive accessory cannot be nested inside it — when this returns a
   *  node the row is wrapped in a flex container and the accessory becomes a
   *  sibling. Fields that pass nothing render exactly as before. */
  rowAccessory?: (id: string, isSelected: boolean) => ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <GrantModeField
      value={value}
      onChange={onChange}
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
          <ul className="bg-popover divide-border max-h-96 divide-y overflow-y-auto rounded-md border">
            {rows.map((o) => {
              const isSel = selected.has(o.id);
              const isOrphan = !optionIds.has(o.id);
              const accessory = rowAccessory?.(o.id, isSel);
              return (
                <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Checkbox
                    variant="black"
                    checked={isSel}
                    onCheckedChange={() => toggle(o.id)}
                    aria-label={o.label}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate font-mono text-sm">
                      {o.label}
                    </span>
                    {o.description ? (
                      <span className="text-muted-foreground block truncate text-xs">
                        {o.description}
                      </span>
                    ) : null}
                  </span>
                  {isOrphan ? (
                    <Badge variant="warning" size="xs">
                      {tI18nComplete.raw('textffa63583dfa6')}
                    </Badge>
                  ) : null}
                  {o.trailing}
                  {accessory}
                </li>
              );
            })}
          </ul>
        );
      }}
    </GrantModeField>
  );
}

/** All · Pick · None over the grouped grantable Kortix permission catalog. */
export function KortixPermissionsField({
  value,
  onChange,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const params = useUiParams();
  const { flags } = useProjectFeatureFlags(typeof params.id === 'string' ? params.id : null);
  const groups = KORTIX_PERMISSIONS_CATALOG.filter((grp) => !grp.featureFlag || flags[grp.featureFlag] === true);
  return (
    <GrantModeField
      value={value}
      onChange={onChange}
    >
      {({ selected, toggle }) => (
        <div className="bg-popover divide-border divide-y rounded-md border">
          {groups.map((grp) => (
            <div key={grp.group} className="space-y-2.5 px-4 py-3">
              <p className="text-muted-foreground text-xs font-medium">{grp.group}</p>
              <div className="-mx-3 grid gap-x-2 gap-y-0.5 sm:grid-cols-2">
                {grp.actions.map((action) => (
                  <Checkbox
                    key={action}
                    variant="black"
                    checked={selected.has(action)}
                    onCheckedChange={() => toggle(action)}
                    label={
                      <span className="font-mono text-xs">
                        {action.replace(/^project\./, '')}
                      </span>
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </GrantModeField>
  );
}
