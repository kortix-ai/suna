/**
 * Pure logic behind the connector tool renderers
 * (`components/session/tool/tools/connector-*-tool.tsx`, `connector-tools.tsx`).
 *
 * Ported from apps/web `tool/tools/connector-list-tool.tsx`,
 * `connector-get-tool.tsx`, `connector-setup-tool.tsx` and `connector-tools.tsx`,
 * with the English copy from `apps/web/translations/en.json`.
 */

import type { ConnectorGetData, ConnectorSetupData } from './projects-tool-output';

export interface ConnectorTrigger {
  title: string;
  subtitle?: string;
  args?: string[];
}

export type ConnectorTone = 'success' | 'warning' | 'destructive';

/** A body section and whether it starts folded (web `FoldedSection` vs `ToolSection`). */
export interface ConnectorSection {
  label: string;
  folded: boolean;
}

/** The arguments a call was made WITH fold; what it answered does not. */
export const CONNECTOR_CALL_SECTIONS = {
  request: { label: 'Request', folded: true },
  response: { label: 'Response', folded: false },
} as const satisfies Record<string, ConnectorSection>;

/** A connector action's JSON schema is for the model; it folds. */
export const CONNECTOR_DESCRIBE_SCHEMA_SECTION = {
  label: 'Input schema',
  folded: true,
} as const satisfies ConnectorSection;

const EMPTY_INPUT_SCHEMA = Object.freeze({ type: 'object', properties: {} });

/** Web: `(status === 'pending' && running) || status === 'running'`. */
export function isToolStreaming(status: string, running: boolean): boolean {
  return (status === 'pending' && running) || status === 'running';
}

// ─── connector_list / connector_get / connector_setup ────────────────────────

export function connectorListTrigger(input: Record<string, unknown>, count: number): ConnectorTrigger {
  const filter = typeof input.filter === 'string' ? input.filter : '';
  return {
    title: 'Listed connectors',
    subtitle: filter ? `Filter: ${filter}` : `${count} connector${count !== 1 ? 's' : ''}`,
  };
}

export function connectorGetTrigger(
  input: Record<string, unknown>,
  data: ConnectorGetData | null,
): ConnectorTrigger {
  const name = typeof input.name === 'string' ? input.name : '';
  return {
    title: data?.name || 'Connector Details',
    subtitle: name && name !== data?.name ? name : data?.description || 'Fetching...',
  };
}

export function connectorSetupTrigger(data: ConnectorSetupData | null, isError: boolean): ConnectorTrigger {
  return {
    title: 'Set up connectors',
    subtitle: isError
      ? 'failed'
      : data
        ? `${data.count} connector${data.count !== 1 ? 's' : ''} configured`
        : 'Setting up...',
    args: data?.success ? ['configured'] : undefined,
  };
}

/** Connector names are the row identity; a repeated name gets an occurrence counter. */
export function keyConnectors(connectors: readonly string[]): { conn: string; key: string }[] {
  const seen = new Map<string, number>();
  return connectors.map((conn) => {
    const n = seen.get(conn) ?? 0;
    seen.set(conn, n + 1);
    return { conn, key: n === 0 ? conn : `${conn}#${n}` };
  });
}

// ─── kortix-connectors_* ─────────────────────────────────────────────────────

export function connectorsTrigger(status: string, count: number): ConnectorTrigger {
  return {
    title: 'Listed connectors',
    args: status === 'completed' ? [`${count} available`] : undefined,
  };
}

export function connectorRowKey(c: Record<string, unknown>): string {
  return String(c.slug ?? '') || `${String(c.name ?? '')}:${String(c.provider ?? '')}`;
}

export function connectorDiscoverTrigger(
  input: Record<string, unknown>,
  status: string,
  matchCount: number,
): ConnectorTrigger {
  const query = String(input.query ?? '').trim();
  return {
    title: 'Searched connector actions',
    subtitle: query || undefined,
    args: status === 'completed' ? [`${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`] : undefined,
  };
}

/** `parsed`: the output parsed as a connector payload (with no matches). */
export function connectorDiscoverEmptyMessage(isStreaming: boolean, query: string, parsed: boolean): string {
  if (isStreaming) return 'Searching…';
  return parsed ? `No tools match "${query}".` : 'No results yet.';
}

export interface ConnectorDescribeView {
  tool: string;
  description: string;
  risk: unknown;
  schema: unknown;
  triggerArgs: string[] | undefined;
}

export function connectorDescribeView(
  input: Record<string, unknown>,
  parsed: Record<string, unknown> | null,
): ConnectorDescribeView {
  return {
    tool: String(parsed?.tool ?? input.tool ?? '').trim(),
    description: parsed?.description ? String(parsed.description) : '',
    risk: parsed?.risk,
    schema: parsed?.inputSchema ?? EMPTY_INPUT_SCHEMA,
    triggerArgs: parsed?.risk ? [String(parsed.risk)] : undefined,
  };
}

export interface ConnectorCallView {
  /** `connector.action`, or whichever of the two exists. */
  ref: string;
  args: Record<string, unknown>;
  ok: boolean;
  outcome: { label: string; tone: ConnectorTone } | null;
  /** The trigger args: risk, then the outcome label. */
  triggerArgs: string[];
  /** The Response section: the failure reason, or the JSON (`data`, else the payload). */
  response: { kind: 'reason'; text: string } | { kind: 'json'; value: unknown } | null;
}

export function connectorCallView(
  input: Record<string, unknown>,
  parsed: Record<string, unknown> | null,
): ConnectorCallView {
  const connector = String(input.connector ?? '').trim();
  const action = String(input.action ?? '').trim();
  const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown>;
  const ref = connector && action ? `${connector}.${action}` : connector || action;

  const ok = parsed?.ok === true;
  const callStatus =
    typeof parsed?.status === 'string' ? parsed.status : ok ? 'ok' : parsed ? 'error' : '';
  const outcome: ConnectorCallView['outcome'] =
    callStatus === 'pending_approval'
      ? { label: 'Needs approval', tone: 'warning' }
      : callStatus === 'denied'
        ? { label: 'Denied', tone: 'destructive' }
        : ok
          ? { label: 'OK', tone: 'success' }
          : parsed
            ? { label: 'Error', tone: 'destructive' }
            : null;

  const triggerArgs = [
    ...(parsed?.risk ? [String(parsed.risk)] : []),
    ...(outcome ? [outcome.label] : []),
  ].filter(Boolean);

  const response: ConnectorCallView['response'] = !parsed
    ? null
    : parsed.reason && !ok
      ? { kind: 'reason', text: String(parsed.reason) }
      : { kind: 'json', value: 'data' in parsed ? parsed.data : parsed };

  return { ref, args, ok, outcome, triggerArgs, response };
}
