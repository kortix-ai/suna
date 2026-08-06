import type { ConnectorAction } from '@kortix/sdk';

export interface ToolGroup {
  key: 'read' | 'write';
  label: string;
  actions: ConnectorAction[];
}

/**
 * Two buckets, because that is the only distinction a non-technical reader
 * needs before granting access: can this look at my data, or change it.
 * `destructive` folds into writes — a delete is a write with worse consequences,
 * and a third bucket would just make the safe/unsafe line harder to see.
 *
 * An empty bucket is omitted rather than rendered as a heading over nothing.
 * Input order is kept inside each bucket: that is the order the connector
 * reports its tools in, which is the order its own docs use.
 */
export function groupToolsByRisk(actions: readonly ConnectorAction[]): ToolGroup[] {
  const read = actions.filter((a) => a.risk === 'read');
  const write = actions.filter((a) => a.risk !== 'read');
  const groups: ToolGroup[] = [];
  if (read.length) groups.push({ key: 'read', label: 'Read-only tools', actions: read });
  if (write.length) groups.push({ key: 'write', label: 'Write tools', actions: write });
  return groups;
}

export interface ToolRowText {
  /** The row's heading. */
  title: string;
  /** The tool path, or `null` when the title already IS the path. */
  path: string | null;
  /** The description, or `null` when it only repeats the title. */
  description: string | null;
}

/**
 * What one row prints, with nothing said twice.
 *
 * An OpenAPI connector commonly derives both `name` and `description` from the
 * same `summary` — the live `petstore` fixture does for all 19 of its tools —
 * so a naive row renders "Deletes a pet." over "Deletes a pet." The path is
 * dropped the same way when the connector never gave the tool a real name.
 */
export function toolRowText(action: ConnectorAction): ToolRowText {
  const name = action.name?.trim();
  const description = action.description?.trim();
  const title = name || action.path;
  const same = (value: string | undefined) =>
    Boolean(value) && value!.toLowerCase() === title.toLowerCase();
  return {
    title,
    path: title === action.path ? null : action.path,
    description: !description || same(description) ? null : description,
  };
}

/**
 * Narrow a tool list by a free-text query. A connector with 60 tools is
 * unusable without one.
 *
 * Matches the path, the display name and the description, because a reader
 * looking for "the one that sends mail" knows the words in the description
 * long before they know `messages.send`. An all-whitespace query is not a
 * query — returning nothing for a stray space would read as "this connector
 * has no tools", which is a different and much worse claim.
 */
export function filterActions(
  actions: readonly ConnectorAction[],
  query: string,
): ConnectorAction[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...actions];
  return actions.filter((a) =>
    `${a.path} ${a.name} ${a.description ?? ''}`.toLowerCase().includes(needle),
  );
}
