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

import type { AgentGrantSetV2 } from '@kortix/sdk';
import { useState } from 'react';

import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';

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
  };
}

const GRANT_MODE_TABS: ReadonlyArray<{ value: GrantMode; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'specific', label: 'Specific' },
  { value: 'none', label: 'None' },
];

/**
 * The agent's grant-mode selector — the catalog's primary control in `agent`
 * scope. Segmented, like the connectors scope strip beside it, so the two
 * read as one header row.
 */
export function GrantModeTabs({ grant, label }: { grant: AgentGrant; label: string }) {
  return (
    <Tabs value={grant.mode} onValueChange={(next) => grant.setMode(next as GrantMode)}>
      <TabsList aria-label={label}>
        {GRANT_MODE_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
