/**
 * Customize · Connectors.
 *
 * Rows come from `kortix.project(id).connectors.list()` (`AdminConnector[]`) —
 * the SAME read `apps/web`'s Connected tab uses, and the only one that carries
 * the setup state (`status`, `authSecret`, `secretSet`,
 * `authorizationStrategy`) that decides connected vs not. `connections.list()`
 * adds how many connections exist behind each connector and whether they still
 * work.
 *
 * `connectors.catalog()` is deliberately NOT called: it returns the callable
 * action list for connectors this project already has, which `list()` already
 * carries as `actions`, at the cost of a second enumeration of every action.
 * The BROWSABLE external catalogue is a third surface again
 * (`discover.list()` / Pipedream / Composio, selected by a feature flag) and
 * is out of scope for a terminal client that cannot run the OAuth redirect.
 *
 * No OAuth here by design: connecting needs a browser round-trip back to the
 * web app, so this tab prints that page's URL and stops.
 */

import type { AdminConnector, Connection } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useKeyboard } from '@opentui/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { theme } from '../../theme.ts';
import { List, type ListItem, Spinner } from '../../ui/index.ts';
import type { CustomizeTabProps } from './customize-screen.tsx';
import { DetailPane, Field } from './fields.tsx';
import { matchesCustomizeBinding } from './keys.ts';
import { errorText } from './use-project-detail.ts';

export type ConnectorSetupWord =
  | 'Connected'
  | 'Needs setup'
  | 'No auth needed'
  | 'User-managed'
  | 'Error';

export interface ConnectorRowData {
  slug: string;
  name: string;
  provider: string;
  setup: ConnectorSetupWord;
  toolCount: number;
  sensitive: boolean;
  /** Connections that exist behind this connector. */
  connections: number;
  /** Connections that are not `active`. */
  brokenConnections: number;
}

/**
 * The web's `connectorSetupStatus`, verbatim in its order of decision.
 *
 * The order matters: a connector reporting `error` is an error whatever its
 * credential says, and a connector that declares no `authSecret` needs no
 * credential at all, so asking `secretSet` first would call it unconnected
 * forever.
 */
export function connectorSetup(connector: AdminConnector): ConnectorSetupWord {
  if (connector.status === 'error') return 'Error';
  if (connector.status === 'needs_auth') return 'Needs setup';
  if (!connector.authSecret) return 'No auth needed';
  if (connector.authorizationStrategy === 'user') return 'User-managed';
  return connector.secretSet ? 'Connected' : 'Needs setup';
}

export function connectorRows(
  connectors: AdminConnector[],
  connections: Connection[] = [],
): ConnectorRowData[] {
  return connectors.map((connector) => {
    const mine = connections.filter((entry) => entry.connector_alias === connector.slug);
    return {
      slug: connector.slug,
      name: connector.name || connector.slug,
      provider: connector.provider,
      setup: connectorSetup(connector),
      toolCount: connector.actions?.length ?? 0,
      sensitive: connector.sensitive,
      connections: mine.length,
      brokenConnections: mine.filter((entry) => entry.status !== 'active').length,
    };
  });
}

/** The web page a user must open to connect this connector. */
export function connectorWebUrl(projectId: string, slug: string, webBaseUrl?: string): string {
  const path = `/projects/${projectId}/connectors?c=${encodeURIComponent(slug)}`;
  if (!webBaseUrl) return path;
  return `${webBaseUrl.replace(/\/$/, '')}${path}`;
}

export interface ConnectorsTabViewProps {
  rows: ConnectorRowData[];
  focused: boolean;
  width: number;
  height: number;
  loading: boolean;
  errorMessage: string | null;
  /** Built by the data half so the view stays free of project ids. */
  connectUrlFor(slug: string): string;
  onInputActive(active: boolean): void;
}

export function ConnectorsTabView({
  rows,
  focused,
  width,
  height,
  loading,
  errorMessage,
  connectUrlFor,
  onInputActive,
}: ConnectorsTabViewProps) {
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.slug ?? null);
  const [detailOpen, setDetailOpen] = useState(false);
  const current = rows.find((row) => row.slug === cursorId) ?? rows[0] ?? null;

  const items = useMemo<ListItem[]>(
    () =>
      rows.map((row) => ({
        id: row.slug,
        glyph: row.setup === 'Connected' ? '✓' : row.setup === 'Error' ? '!' : '○',
        label: `${row.name} · ${row.toolCount} tools · ${row.provider}`,
        right: row.setup,
        dim: row.setup === 'Needs setup',
      })),
    [rows],
  );

  const close = useCallback(() => {
    setDetailOpen(false);
    onInputActive(false);
  }, [onInputActive]);

  useKeyboard((key) => {
    if (!focused) return;
    if (detailOpen) {
      if (matchesCustomizeBinding(key, 'customize.cancel')) close();
      return;
    }
    if (matchesCustomizeBinding(key, 'customize.open') && current) {
      setDetailOpen(true);
      onInputActive(true);
    }
  });

  if (detailOpen && current) {
    return (
      <DetailPane title={current.name} right={current.setup} width={width}>
        <Field label="Slug" value={current.slug} />
        <Field label="Provider" value={current.provider} />
        <Field label="Tools" value={String(current.toolCount)} />
        <Field label="Sensitive" value={current.sensitive ? 'yes' : 'no'} />
        <Field
          label="Connections"
          value={
            current.connections === 0
              ? 'none'
              : current.brokenConnections === 0
                ? `${current.connections} active`
                : `${current.connections} (${current.brokenConnections} not active)`
          }
        />
        <text fg={theme.faint}>Connect or re-authorize in the web app:</text>
        <text fg={theme.dim}>{`  ${connectUrlFor(current.slug)}`}</text>
      </DetailPane>
    );
  }

  if (errorMessage) return <text fg={theme.danger}>{errorMessage}</text>;
  if (loading && rows.length === 0) return <Spinner label="loading connectors" />;

  return (
    <box flexDirection="column" width={width}>
      <List
        items={items}
        focused={focused && !detailOpen}
        selectedId={current?.slug ?? null}
        onSelectedChange={setCursorId}
        onOpen={() => {
          setDetailOpen(true);
          onInputActive(true);
        }}
        maxRows={Math.max(height - 1, 1)}
        width={width}
        emptyText="No connectors yet. Add one in the web app under Customize · Connectors."
      />
      {rows.length > 0 ? (
        <text fg={theme.faint}>Enter details · ✓ connected · OAuth happens in the web app</text>
      ) : null}
    </box>
  );
}

export interface ConnectorsTabExtraProps extends CustomizeTabProps {
  webBaseUrl?: string;
}

export function ConnectorsTab({
  projectId,
  focused,
  width,
  height,
  webBaseUrl,
  onInputActive,
}: ConnectorsTabExtraProps) {
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => kortix().project(projectId).connectors.list(),
    retry: false,
  });
  const connectionsQuery = useQuery({
    queryKey: [...qk.project.connectors(projectId), 'connections'],
    queryFn: () => kortix().project(projectId).connectors.connections.list(),
    retry: false,
  });

  const rows = useMemo(
    () =>
      connectorRows(
        connectorsQuery.data?.connectors ?? [],
        connectionsQuery.data?.connections ?? [],
      ),
    [connectorsQuery.data, connectionsQuery.data],
  );

  const connectUrlFor = useCallback(
    (slug: string) => connectorWebUrl(projectId, slug, webBaseUrl),
    [projectId, webBaseUrl],
  );

  return (
    <ConnectorsTabView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      loading={connectorsQuery.isLoading}
      errorMessage={connectorsQuery.isError ? errorText(connectorsQuery.error) : null}
      connectUrlFor={connectUrlFor}
      onInputActive={onInputActive}
    />
  );
}
