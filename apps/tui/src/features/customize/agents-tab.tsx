/**
 * Customize · Agents.
 *
 * The project's agents, from the SERVER-side project config
 * (`ProjectConfigSummary.agents`) — the same source
 * `apps/web/src/features/workspace/capabilities/agents/agents-page.tsx` reads,
 * and the one that works before any sandbox runtime exists.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { theme } from '../../theme.ts';
import { List, type ListItem, Spinner } from '../../ui/index.ts';
import type { CustomizeTabProps } from './customize-screen.tsx';
import { DetailPane, Field, Paragraph } from './fields.tsx';
import { matchesCustomizeBinding } from './keys.ts';
import { useProjectDetailState } from './use-project-detail.ts';

/** The web's fallback when an agent declares no `model:` frontmatter. */
export const DEFAULT_MODEL_TEXT = 'Uses the project default';

export interface AgentRowData {
  name: string;
  description: string | null;
  model: string | null;
  mode: string | null;
  path: string;
  enabled: boolean;
  isDefault: boolean;
  scope: {
    env: string[] | 'all';
    connectors: string[] | 'all';
    kortix_cli: string[] | 'all';
  } | null;
}

/**
 * Config agents in display order, with the project default marked.
 *
 * `default_agent` is the provider-neutral field; `open_code_default_agent` is
 * the deprecated one older servers still answer with, so both are consulted.
 */
export function agentRows(config: {
  agents: Array<{
    name: string;
    path: string;
    description: string | null;
    mode: string | null;
    model?: string | null;
    enabled?: boolean;
    scope?: AgentRowData['scope'];
  }>;
  default_agent?: string | null;
  open_code_default_agent?: string | null;
}): AgentRowData[] {
  const fallback = config.default_agent ?? config.open_code_default_agent ?? null;
  return config.agents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    model: agent.model ?? null,
    mode: agent.mode,
    path: agent.path,
    // `enabled` is absent on an OpenCode-discovered agent, which means on.
    enabled: agent.enabled !== false,
    isDefault: fallback != null && agent.name === fallback,
    scope: agent.scope ?? null,
  }));
}

function scopeText(value: string[] | 'all' | undefined): string {
  if (value === 'all') return 'all';
  if (!value) return '—';
  return value.length === 0 ? 'none' : value.join(', ');
}

export interface AgentsTabViewProps {
  rows: AgentRowData[];
  focused: boolean;
  width: number;
  height: number;
  loading: boolean;
  errorMessage: string | null;
  onInputActive(active: boolean): void;
}

export function AgentsTabView({
  rows,
  focused,
  width,
  height,
  loading,
  errorMessage,
  onInputActive,
}: AgentsTabViewProps) {
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.name ?? null);
  const [detailOpen, setDetailOpen] = useState(false);

  const current = rows.find((row) => row.name === cursorId) ?? rows[0] ?? null;

  const items = useMemo<ListItem[]>(
    () =>
      rows.map((row) => ({
        id: row.name,
        // The default agent carries the same star the web card shows.
        glyph: row.isDefault ? '★' : ' ',
        label: row.description ? `${row.name} · ${row.description}` : row.name,
        right: row.enabled ? (row.model ?? 'project default') : 'Disabled',
        dim: !row.enabled,
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
      <DetailPane
        title={current.name}
        right={current.isDefault ? 'project default' : ''}
        width={width}
      >
        <Field label="Mode" value={current.mode ?? 'primary'} />
        <Field label="Model" value={current.model ?? DEFAULT_MODEL_TEXT} />
        <Field label="Enabled" value={current.enabled ? 'yes' : 'no'} />
        <Field label="Defined in" value={current.path} />
        <Field label="Env scope" value={scopeText(current.scope?.env)} />
        <Field label="Connectors" value={scopeText(current.scope?.connectors)} />
        <Field label="kortix CLI" value={scopeText(current.scope?.kortix_cli)} />
        <Paragraph text={current.description ?? ''} width={Math.max(width - 2, 20)} maxLines={4} />
      </DetailPane>
    );
  }

  if (errorMessage) return <text fg={theme.danger}>{errorMessage}</text>;
  if (loading && rows.length === 0) return <Spinner label="loading agents" />;

  return (
    <box flexDirection="column" width={width}>
      <List
        items={items}
        focused={focused && !detailOpen}
        selectedId={current?.name ?? null}
        onSelectedChange={setCursorId}
        onOpen={() => {
          setDetailOpen(true);
          onInputActive(true);
        }}
        maxRows={Math.max(height - 1, 1)}
        width={width}
        emptyText="No agents yet. Add one under .opencode/agent/ or kortix.yaml."
      />
      {rows.length > 0 ? <text fg={theme.faint}>Enter details · ★ project default</text> : null}
    </box>
  );
}

export function AgentsTab({ projectId, focused, width, height, onInputActive }: CustomizeTabProps) {
  const detail = useProjectDetailState(projectId);
  const rows = useMemo(() => (detail.config ? agentRows(detail.config) : []), [detail.config]);
  return (
    <AgentsTabView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      loading={detail.loading}
      errorMessage={detail.errorMessage}
      onInputActive={onInputActive}
    />
  );
}
