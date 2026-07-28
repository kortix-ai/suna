import type { ConnectorAction, ConnectorPolicyAction } from '@kortix/sdk';

/**
 * The two buckets the connector detail screen shows its tools in. Perplexity
 * splits a connector's tools into "Read-only" and "Write / delete" so the
 * dangerous half is visible at a glance instead of buried in a flat list.
 */
export type ToolGroupKey = 'readOnly' | 'write';

export interface ToolGroup {
  key: ToolGroupKey;
  label: string;
  tools: ConnectorAction[];
}

export const TOOL_GROUP_LABEL: Record<ToolGroupKey, string> = {
  readOnly: 'Read-only tools',
  write: 'Write / delete tools',
};

/**
 * Split a connector's actions by risk.
 *
 * Only `read` is read-only. Everything else — `write`, `destructive`, and any
 * value a newer API adds that this build does not know about — lands in the
 * write bucket. That default is deliberate: mislabelling a destructive tool as
 * read-only would under-state its blast radius in the one UI where the user
 * grants it permission, so an unknown risk is treated as the dangerous one.
 *
 * Input order is preserved inside each group, so the list stays stable across
 * renders and matches the order the API returned.
 */
export function groupToolsByRisk(actions: readonly ConnectorAction[]): {
  readOnly: ConnectorAction[];
  write: ConnectorAction[];
} {
  const readOnly: ConnectorAction[] = [];
  const write: ConnectorAction[] = [];
  for (const action of actions) {
    if (action.risk === 'read') readOnly.push(action);
    else write.push(action);
  }
  return { readOnly, write };
}

/** The same split as {@link groupToolsByRisk}, as a list ready to render. Empty groups drop out. */
export function toolGroups(actions: readonly ConnectorAction[]): ToolGroup[] {
  const { readOnly, write } = groupToolsByRisk(actions);
  const groups: ToolGroup[] = [
    { key: 'readOnly', label: TOOL_GROUP_LABEL.readOnly, tools: readOnly },
    { key: 'write', label: TOOL_GROUP_LABEL.write, tools: write },
  ];
  return groups.filter((g) => g.tools.length > 0);
}

/**
 * A human label for a tool row. Connector paths are machine ids
 * (`search_emails`, `calendar/update-event`), which read badly in a list the
 * user scans to decide what to grant. The raw path stays available — the row
 * shows it on hover and the rules editor still matches on it — so nothing is
 * lost by leading with prose.
 */
export function toolLabel(action: ConnectorAction): string {
  const raw = action.path.split(/[/.]/).pop() ?? action.path;
  const words = raw.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!words) return action.path;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Case-insensitive match over a tool's path and description — the detail screen's search. */
export function matchesToolSearch(action: ConnectorAction, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${action.path} ${action.description ?? ''}`.toLowerCase().includes(q);
}

export function filterTools(actions: readonly ConnectorAction[], query: string): ConnectorAction[] {
  const q = query.trim();
  if (!q) return [...actions];
  return actions.filter((a) => matchesToolSearch(a, q));
}

/**
 * The single policy a whole group resolves to, for the group-level "Allow" control.
 * `null` means the group is split across several choices, so the control shows no
 * one value and applying a choice overwrites every tool in the group.
 */
export function groupPolicy(
  tools: readonly ConnectorAction[],
  perTool: Record<string, ConnectorPolicyAction>,
): ConnectorPolicyAction | 'default' | null {
  if (tools.length === 0) return null;
  const first = perTool[tools[0]!.path] ?? 'default';
  for (const tool of tools) {
    if ((perTool[tool.path] ?? 'default') !== first) return null;
  }
  return first;
}
