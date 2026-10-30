'use client';

import type { UiTranslator } from '../../../i18n';
import { useTranslations as useI18nTranslations } from '../../../i18n';
/**
 * The grant fields of the agent editor: the grant sentence (`GrantModeTabs`)
 * over a list that is always shown, flat (skills, connectors, the registry
 * grants) or grouped (kortix_permissions).
 */

import { Badge } from '../../../primitives/badge';
import { Checkbox } from '../../../primitives/checkbox';
import type { AgentGrantSetV2 } from '@kortix/sdk';
import type { ReactNode } from 'react';
import { KORTIX_PERMISSIONS_CATALOG } from './agent-editor-catalog';
import { useUiParams } from '../../../providers/ui-provider';
import { useProjectFeatureFlags } from '../../../internal/lib/use-project-feature-flags';
import { GrantModeTabs, plainGrantSwitch, useAgentGrant, withCatalog } from '../../shared/agent-resource-scope';

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
   *  field's "personal" toggle). The row itself is a checkbox, so an
   *  interactive accessory is a sibling, never nested. */
  rowAccessory?: (id: string, isSelected: boolean) => ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  // The same grant sentence and always-listed rows as every other Access view:
  // All checks every row, None none, Specific the granted ones. A row turned
  // off under All keeps the rest (`plainGrantSwitch`).
  const grant = useAgentGrant(value, onChange);
  const ids = options.map((o) => o.id);
  const box = plainGrantSwitch(value, ids, onChange);
  const optionIds = new Set(ids);
  const orphans: GrantOption[] = (Array.isArray(value) ? value : [])
    .filter((id) => !optionIds.has(id))
    .map((id) => ({ id, label: id }));
  const rows = [...options, ...orphans];
  return (
    <div className="space-y-3">
      <GrantModeTabs grant={withCatalog(grant, ids)} label={tI18nComplete.raw('text74009e6664f5')} />
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyLabel}</p>
      ) : (
        <ul className="bg-popover divide-border max-h-96 divide-y overflow-y-auto rounded-md border">
          {rows.map((o) => {
            const isOrphan = !optionIds.has(o.id);
            const control = isOrphan
              ? { checked: true, onCheckedChange: () => onChange((value as string[]).filter((id) => id !== o.id)) }
              : box(o.id);
            const accessory = rowAccessory?.(o.id, control.checked);
            return (
              <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
                <Checkbox variant="black" {...control} aria-label={o.label} />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate font-mono text-sm">{o.label}</span>
                  {o.description ? (
                    <span className="text-muted-foreground block truncate text-xs">{o.description}</span>
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
      )}
    </div>
  );
}

/**
 * The grant sentence over the grouped Kortix permission catalog, listed in
 * every mode like every other Access view: All checks every box, None none,
 * Specific the granted ones. A box turned off under All keeps the rest.
 */
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
  const ids = groups.flatMap((grp) => grp.actions);
  const grant = useAgentGrant(value, onChange);
  const box = plainGrantSwitch(value, ids, onChange);
  return (
    <div className="space-y-5">
      <GrantModeTabs grant={withCatalog(grant, ids)} label={tI18nComplete.raw('text74009e6664f5')} />
      <div className="bg-popover divide-border divide-y rounded-md border">
        {groups.map((grp) => (
          <div key={grp.group} className="space-y-2.5 px-4 py-3">
            <p className="text-muted-foreground text-xs font-medium">{grp.group}</p>
            <div className="-mx-3 grid gap-x-2 gap-y-0.5 sm:grid-cols-2">
              {grp.actions.map((action) => (
                <Checkbox
                  key={action}
                  variant="black"
                  {...box(action)}
                  label={<span className="font-mono text-xs">{action.replace(/^project\./, '')}</span>}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
