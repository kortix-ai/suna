'use client';

/**
 * The one scope contract every resource catalog takes, so a single component
 * serves two surfaces (Marko, 2026-10-24):
 *
 *  - **global** — the full project catalog, the Customize/Project-Admin tab.
 *    Every connector, skill, model the project has. No grant.
 *  - **agent** — the SAME catalog scoped to one agent on its config page. Each
 *    card carries a grant control; toggling it grants or revokes the resource
 *    for THIS agent by writing `agents.<name>.<set>` in kortix.yaml.
 *
 * A page reads `scope.kind` to pick its heading, and in `agent` scope reads the
 * `AgentGrant` to draw and drive the per-card checkbox. One component, two
 * variants — not two pages that drift.
 */

import type { AgentCapabilityGrant, AgentGrantSetV2 } from '@kortix/sdk';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { useCapabilityShellEmbed } from './capability-page-shell';

/** Which surface a resource catalog renders for. */
export type ResourceScope = { kind: 'global' } | { kind: 'agent'; agentName: string };

/**
 * All · Specific · None, the agent's grant over one resource set. `all` and
 * `none` decide every row; `specific` is the explicit pick list. `undefined`,
 * `'none'` and `[]` all read as None.
 */
export type GrantMode = 'all' | 'specific' | 'none';

export interface AgentGrant {
  /** The raw stored value (`agents.<name>.connectors` etc.). */
  value: AgentGrantSetV2 | undefined;
  mode: GrantMode;
  /** Is `id` granted right now — true for every id in `all` mode. */
  isGranted: (id: string) => boolean;
  /** Add or remove one id from the pick list (only meaningful in `specific`). */
  toggle: (id: string) => void;
  setMode: (mode: GrantMode) => void;
  /** Write the whole grant (a row switch under All keeps the rest: `plainGrantSwitch`). */
  set?: (next: AgentGrantSetV2) => void;
}

/**
 * Drives an {@link AgentGrant} off a draft value and its setter. Mirrors
 * `GrantModeField`'s transitions, including the empty-pick nuance: switching to
 * Specific with nothing picked stays Specific (not None) via a local intent
 * flag, so the checklist is reachable before the first pick.
 */
export function useAgentGrant(
  value: AgentGrantSetV2 | undefined,
  onChange: (next: AgentGrantSetV2) => void,
): AgentGrant {
  const [wantSpecific, setWantSpecific] = useState(() => Array.isArray(value) && value.length > 0);
  const mode: GrantMode =
    value === 'all'
      ? 'all'
      : Array.isArray(value) && (value.length > 0 || wantSpecific)
        ? 'specific'
        : 'none';
  const selected = new Set(Array.isArray(value) ? value : []);
  return {
    value,
    mode,
    isGranted: (id) => (mode === 'all' ? true : selected.has(id)),
    toggle: (id) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange([...next]);
    },
    setMode: (next) => {
      setWantSpecific(next === 'specific');
      if (next === 'all') return onChange('all');
      if (next === 'none') return onChange('none');
      onChange(Array.isArray(value) ? value : []);
    },
    set: (next) => {
      setWantSpecific(Array.isArray(next) && next.length > 0);
      onChange(next);
    },
  };
}

/**
 * The ids a Specific grant names that the catalog no longer holds: a resource
 * deleted or renamed after the grant was written. The agent page lists them
 * beside the catalog with a Missing mark, so the editor can see each one and
 * revoke it. All and None name no id, so they have none.
 */
export function grantOrphans(value: AgentGrantSetV2 | undefined, known: Iterable<string>): string[] {
  if (!Array.isArray(value)) return [];
  const have = new Set(known);
  return value.filter((id) => !have.has(id));
}

const GRANT_MODE_TABS: ReadonlyArray<{ value: GrantMode; labelKey: string }> = [
  { value: 'all', labelKey: 'modeAll' },
  { value: 'specific', labelKey: 'modeSpecific' },
  { value: 'none', labelKey: 'modeNone' },
];

/**
 * The agent's grant-mode selector, the catalog's primary control in `agent`
 * scope. A select inside one sentence ("researcher can use [Specific]"), then
 * one muted line that says what the mode means, so the decision never reads
 * as a list filter. It takes its own row: a catalog's list filters (All |
 * Connected) sit with the list they filter, never beside it. `agentName`
 * names the agent outside an embedded resource screen (Kortix permissions).
 */
export function GrantModeTabs({
  grant,
  label,
  agentName,
}: {
  grant: AgentGrant;
  label: string;
  agentName?: string;
}) {
  const t = useTranslations('agentScope');
  const tTabs = useTranslations('agentEditor.tabs');
  const embed = useCapabilityShellEmbed();
  const name = agentName ?? embed?.agentName;
  const hint =
    grant.mode === 'all'
      ? tTabs('grantAllHint')
      : grant.mode === 'specific'
        ? tTabs('grantSpecificHint')
        : tTabs('grantNoneHint');
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex min-w-0 items-center gap-2">
        {name ? (
          <span className="text-foreground shrink-0 truncate text-sm">
            {tTabs('canUse', { name: agentDisplayName(name) })}
          </span>
        ) : null}
        <Select value={grant.mode} onValueChange={(next) => grant.setMode(next as GrantMode)}>
          <SelectTrigger aria-label={label} size="sm" className="w-36 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {GRANT_MODE_TABS.map((tab) => (
              <SelectItem key={tab.value} value={tab.value}>
                {t(tab.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-muted-foreground min-w-0 text-sm text-pretty">{hint}</p>
    </div>
  );
}

/**
 * A grant in the plain All · Specific · None form. `{ exclude }` exists only
 * on kortix_version 3 skills and extensions, which the capability switches
 * edit; a v2 screen that receives one reads it as All.
 */
export function plainGrant(value: AgentCapabilityGrant | undefined): AgentGrantSetV2 | undefined {
  return value === undefined || typeof value === 'string' || Array.isArray(value) ? value : 'all';
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
  return (id: string): { checked: boolean; onCheckedChange: (on: boolean) => void } => ({
    checked: value === 'all' || picked.includes(id),
    onCheckedChange: (on) => {
      const next = on ? [...picked.filter((x) => x !== id), id] : picked.filter((x) => x !== id);
      onChange(next.length > 0 ? next : 'none');
    },
  });
}
