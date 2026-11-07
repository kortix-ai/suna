/**
 * `/connectors`: the web connectors page in a terminal.
 *
 * Left, the list: "In this project" (every connector profile, with its state
 * and accounts) and "Catalogue" (the Discover catalogue: MCP servers, APIs and
 * Composio apps, paged as you scroll). `/` searches both; the catalogue
 * search runs on the server. Right, the selected row's sheet: a connector's
 * accounts (`connector-sheet.tsx`) or an app's ways to connect
 * (`catalog-sheet.tsx`). Under 90 columns one pane shows at a time.
 *
 * Keys: the list answers while it has focus; Enter moves focus to the sheet,
 * and Esc moves it back, then closes the screen. While a sheet runs a flow
 * (an input, a confirm, a sign-in) it owns every key, Esc included.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { printable } from '../../lib/printable.ts';
import { theme } from '../../theme.ts';
import { Spinner, layoutRow } from '../../ui/index.ts';
import { CatalogSheet } from './catalog-sheet.tsx';
import { ConnectorSheet } from './connector-sheet.tsx';
import {
  type ConnectorsRow,
  TONE_WORD,
  catalogMeta,
  connectorMeta,
  connectorsRows,
} from './connectors-model.ts';
import { matchesConnectorsBinding as is } from './keys.ts';
import { useConnectors } from './use-connectors.ts';
import { PICK_WORKSPACE_TEXT } from '../../lib/workspaces.ts';

export interface ConnectorsScreenProps {
  projectId: string | null;
  accountId: string | null;
  focused: boolean;
  width: number;
  height: number;
  webBaseUrl: string;
  /** `/connectors <query>`: search for it, and open the one connector it names. */
  target?: string | null;
  onBack(): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** True while Esc is ours: the sheet is open, a search or a flow is active. */
  onHoldsBack?(holds: boolean): void;
}

const SPLIT_MIN_WIDTH = 90;

export function ConnectorsScreen(props: ConnectorsScreenProps) {
  if (!props.projectId) {
    return <text fg={theme.faint}>{PICK_WORKSPACE_TEXT}</text>;
  }
  return <ConnectorsScreenBody {...props} projectId={props.projectId} />;
}

function ConnectorsScreenBody({
  projectId,
  accountId,
  focused,
  width,
  height,
  webBaseUrl,
  target: initialQuery,
  onBack,
  onToast,
  onHoldsBack,
}: ConnectorsScreenProps & { projectId: string }) {
  const [search, setSearch] = useState(initialQuery?.trim() ?? '');
  const [filtering, setFiltering] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<'list' | 'sheet'>('list');
  const [sheetBusy, setSheetBusy] = useState(false);
  const [addRequest, setAddRequest] = useState<string | null>(null);
  const data = useConnectors(projectId, accountId, search);

  const { project, catalog } = useMemo(
    () => connectorsRows({ connectors: data.connectors, connections: data.connections, catalog: data.catalog, search }),
    [data.connectors, data.connections, data.catalog, search],
  );
  const ordered = useMemo<ConnectorsRow[]>(() => [...project, ...catalog], [project, catalog]);
  const selectedIndex = Math.max(
    ordered.findIndex((row) => row.id === selectedId),
    0,
  );
  const selected: ConnectorsRow | undefined = ordered[selectedIndex];

  const holdsBack = pane === 'sheet' || filtering || search.length > 0 || sheetBusy;
  useEffect(() => {
    onHoldsBack?.(holdsBack);
  }, [holdsBack, onHoldsBack]);
  useEffect(() => () => onHoldsBack?.(false), [onHoldsBack]);

  // `/connectors github`: a query that names one of the project's connectors opens it.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !initialQuery || data.loading) return;
    opened.current = true;
    const q = initialQuery.trim().toLowerCase();
    const hit = project.filter((row) => row.slug.toLowerCase() === q || row.name.toLowerCase() === q);
    if (hit.length === 1) {
      setSelectedId(hit[0]!.id);
      setPane('sheet');
    }
  }, [initialQuery, data.loading, project]);

  // The first row is the selection until the reader moves.
  useEffect(() => {
    if ((!selectedId || !ordered.some((row) => row.id === selectedId)) && ordered[0] && pane === 'list') {
      setSelectedId(ordered[0].id);
    }
  }, [selectedId, ordered, pane]);

  // The catalogue loads its next page when the selection reaches its last row.
  const { catalogHasMore, loadMoreCatalog } = data;
  useEffect(() => {
    if (selected?.kind === 'catalog' && selectedIndex >= ordered.length - 3 && catalogHasMore) loadMoreCatalog();
  }, [selected, selectedIndex, ordered.length, catalogHasMore, loadMoreCatalog]);

  // Two keys inside one frame both run before React renders, so each step
  // reads the selection it is moving from, not the render's.
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const move = useCallback((delta: number) => {
    setSelectedId((previous) => {
      const rows = orderedRef.current;
      if (rows.length === 0) return previous;
      const from = Math.max(
        rows.findIndex((row) => row.id === previous),
        0,
      );
      return rows[Math.min(Math.max(from + delta, 0), rows.length - 1)]!.id;
    });
  }, []);

  const onInstalled = useCallback((slug: string, addAccount: boolean) => {
    setSearch('');
    setSelectedId(`c:${slug}`);
    setPane('sheet');
    setAddRequest(addAccount ? slug : null);
  }, []);

  useKeyboard((key) => {
    if (!focused) return;
    if (pane === 'sheet') {
      if (sheetBusy) return;
      if (is(key, 'connectors.back')) setPane('list');
      return;
    }
    if (filtering) {
      // The `<input>` owns typing; Enter keeps the filter, Esc clears it.
      if (is(key, 'connectors.cancel')) {
        setSearch('');
        setFiltering(false);
      }
      if (key.name === 'down') move(1);
      if (key.name === 'up') move(-1);
      return;
    }
    if (is(key, 'connectors.down')) return move(1);
    if (is(key, 'connectors.up')) return move(-1);
    if (is(key, 'connectors.first')) return setSelectedId(ordered[0]?.id ?? null);
    if (is(key, 'connectors.last')) return setSelectedId(ordered.at(-1)?.id ?? null);
    if (is(key, 'connectors.filter')) return setFiltering(true);
    if (is(key, 'connectors.open') && selected) return setPane('sheet');
    if (is(key, 'connectors.back')) {
      if (search) return setSearch('');
      onBack();
    }
  });

  const split = width >= SPLIT_MIN_WIDTH;
  const listWidth = split ? Math.min(Math.max(Math.floor(width * 0.4), 32), 52) : width;
  const sheetWidth = split ? width - listWidth - 2 : width;

  if (data.error) {
    return (
      <box flexDirection="column">
        <text fg={theme.danger}>{data.error}</text>
        <text fg={theme.faint}>Esc back</text>
      </box>
    );
  }
  if (data.loading && ordered.length === 0) return <Spinner label="loading connectors" />;

  const showList = split || pane === 'list';
  const showSheet = selected && (split || pane === 'sheet');
  const sheetFocused = focused && pane === 'sheet';

  return (
    <box flexDirection="row" width={width} height={height}>
      {showList ? (
        <ConnectorList
          project={project}
          catalog={catalog}
          catalogTotal={data.catalogTotal}
          catalogLoading={data.catalogLoading}
          selectedId={selected?.id ?? null}
          search={search}
          filtering={filtering && focused && pane === 'list'}
          onSearch={setSearch}
          onFilterDone={() => setFiltering(false)}
          active={pane === 'list'}
          width={listWidth}
          height={height}
        />
      ) : null}
      {split ? <box width={2} /> : null}
      {showSheet && selected.kind === 'connector' ? (
        <ConnectorSheet
          key={selected.id}
          projectId={projectId}
          row={selected}
          data={data}
          focused={sheetFocused}
          width={sheetWidth}
          height={height}
          webBaseUrl={webBaseUrl}
          addRequest={addRequest === selected.slug && sheetFocused}
          onAddRequestHandled={() => setAddRequest(null)}
          onToast={onToast}
          onBusy={setSheetBusy}
          onRemoved={() => {
            setPane('list');
            setSelectedId(null);
          }}
        />
      ) : null}
      {showSheet && selected.kind === 'catalog' ? (
        <CatalogSheet
          key={selected.id}
          projectId={projectId}
          row={selected}
          data={data}
          focused={sheetFocused}
          width={sheetWidth}
          height={height}
          webBaseUrl={webBaseUrl}
          onToast={onToast}
          onBusy={setSheetBusy}
          onInstalled={onInstalled}
        />
      ) : null}
    </box>
  );
}

interface ConnectorListProps {
  project: ReturnType<typeof connectorsRows>['project'];
  catalog: ReturnType<typeof connectorsRows>['catalog'];
  catalogTotal: number;
  catalogLoading: boolean;
  selectedId: string | null;
  search: string;
  filtering: boolean;
  onSearch(value: string): void;
  onFilterDone(): void;
  active: boolean;
  width: number;
  height: number;
}

function ConnectorList({
  project,
  catalog,
  catalogTotal,
  catalogLoading,
  selectedId,
  search,
  filtering,
  onSearch,
  onFilterDone,
  active,
  width,
  height,
}: ConnectorListProps) {
  const inner = Math.max(width - 1, 8);
  type Line = { key: string; text: string; fg: string; bold?: boolean };
  const lines: Line[] = [];
  const pushRow = (row: ConnectorsRow) => {
    const on = row.id === selectedId;
    const mark = row.kind === 'connector' ? (row.tone === 'connected' ? '✓' : row.tone === 'error' ? '!' : '○') : row.installed ? '✓' : '+';
    const right = row.kind === 'connector' ? TONE_WORD[row.tone] : row.installed ? 'Installed' : '';
    lines.push({
      key: row.id,
      text: layoutRow(`${on ? '›' : ' '} ${mark} ${printable(row.name)}`, right, inner),
      fg: on ? (active ? theme.accent : theme.fg) : row.kind === 'catalog' && !row.installed ? theme.dim : theme.fg,
      bold: on,
    });
    if (on) {
      lines.push({
        key: `${row.id}-meta`,
        text: `     ${printable(row.kind === 'connector' ? connectorMeta(row) : catalogMeta(row))}`,
        fg: theme.faint,
      });
    }
  };
  lines.push({ key: 'h-project', text: `In this workspace · ${project.length}`, fg: theme.faint });
  if (project.length === 0) {
    lines.push({
      key: 'e-project',
      text: search.trim() ? '  None match' : '  No connectors yet. Pick one from the catalogue.',
      fg: theme.faint,
    });
  }
  for (const row of project) pushRow(row);
  lines.push({ key: 'h-catalog', text: `Catalogue · ${catalogTotal}${catalogLoading ? ' · loading…' : ''}`, fg: theme.faint });
  if (catalog.length === 0 && !catalogLoading) {
    lines.push({ key: 'e-catalog', text: `  No app matches “${search.trim()}”`, fg: theme.faint });
  }
  for (const row of catalog) pushRow(row);

  // Keep the selection in view: the window starts so the selected row sits mid-list.
  const room = Math.max(height - 2, 3);
  const at = Math.max(
    lines.findIndex((line) => line.key === selectedId),
    0,
  );
  const start = lines.length <= room ? 0 : Math.min(Math.max(at - Math.floor(room / 2), 0), lines.length - room);
  const visible = lines.slice(start, start + room);

  return (
    <box flexDirection="column" width={width} height={height}>
      <box flexDirection="row" width={width}>
        <text fg={filtering ? theme.brand : theme.faint}>{filtering ? '▌' : '/ '}</text>
        {filtering ? (
          <input
            focused
            flexGrow={1}
            value={search}
            placeholder="Search connectors and apps"
            onInput={onSearch}
            onSubmit={onFilterDone}
          />
        ) : (
          <text fg={search ? theme.fg : theme.faint}>{search || 'Search connectors and apps'}</text>
        )}
      </box>
      {visible.map((line) => {
        const text = line.text.length > inner ? `${line.text.slice(0, inner - 1)}…` : line.text;
        return (
          <text key={line.key} fg={line.fg}>
            {line.bold ? <strong>{text}</strong> : text}
          </text>
        );
      })}
      <box flexGrow={1} />
      <text fg={theme.faint}>{active ? 'j/k move · / search · Enter open · Esc close' : 'Esc list'}</text>
    </box>
  );
}
