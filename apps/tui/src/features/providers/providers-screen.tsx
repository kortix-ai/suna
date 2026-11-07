/**
 * `/providers`: the web Models page's provider list and sheet, in a terminal.
 *
 * Left, the list: "In use" (Kortix and every connected provider) and
 * "Available" (the rest of the catalogue), in the web's fixed order; `/`
 * searches by name, id or env var. Right, the selected provider's sheet
 * (`provider-sheet.tsx`). Under 90 columns one pane shows at a time.
 *
 * Keys: the list answers while it has focus; Enter moves focus to the sheet,
 * and Esc moves it back, then closes the screen. While the sheet runs a flow
 * (an input, a confirm, a sign-in) it owns every key.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { theme } from '../../theme.ts';
import { Spinner, layoutRow } from '../../ui/index.ts';
import { matchesProvidersBinding as is } from './keys.ts';
import { ProviderSheet } from './provider-sheet.tsx';
import { type ProviderRow, providerMeta, providerRows } from './providers-model.ts';
import { useProviders } from './use-providers.ts';
import { PICK_WORKSPACE_TEXT } from '../../lib/workspaces.ts';

export interface ProvidersScreenProps {
  projectId: string | null;
  accountId: string | null;
  focused: boolean;
  width: number;
  height: number;
  /** Open this provider's sheet first (`/providers openai`). */
  target?: string | null;
  onBack(): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** True while Esc is ours: the sheet is open, a search or a flow is active. */
  onHoldsBack?(holds: boolean): void;
}

const SPLIT_MIN_WIDTH = 90;

export function ProvidersScreen(props: ProvidersScreenProps) {
  if (!props.projectId) {
    return <text fg={theme.faint}>{PICK_WORKSPACE_TEXT}</text>;
  }
  return <ProvidersScreenBody {...props} projectId={props.projectId} />;
}

function ProvidersScreenBody({
  projectId,
  accountId,
  focused,
  width,
  height,
  target: initialProviderId,
  onBack,
  onToast,
  onHoldsBack,
}: ProvidersScreenProps & { projectId: string }) {
  const data = useProviders(projectId, accountId);
  const [search, setSearch] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialProviderId ?? null);
  const [pane, setPane] = useState<'list' | 'sheet'>(initialProviderId ? 'sheet' : 'list');
  const [sheetBusy, setSheetBusy] = useState(false);

  const { inUse, available } = useMemo(
    () =>
      providerRows({
        catalogue: data.catalogue,
        managed: data.managed,
        connectedIds: data.connectedIds,
        pooledIds: data.pooledIds,
        disabledProviders: data.disabledProviders,
        search,
      }),
    [data.catalogue, data.managed, data.connectedIds, data.pooledIds, data.disabledProviders, search],
  );
  const ordered = useMemo(() => [...inUse, ...available], [inUse, available]);
  const selectedIndex = Math.max(ordered.findIndex((row) => row.id === selectedId), 0);
  const selected: ProviderRow | undefined = ordered[selectedIndex];
  const entry = selected ? data.byId.get(selected.id) : undefined;

  const holdsBack = pane === 'sheet' || filtering || search.length > 0 || sheetBusy;
  useEffect(() => {
    onHoldsBack?.(holdsBack);
  }, [holdsBack, onHoldsBack]);
  useEffect(() => () => onHoldsBack?.(false), [onHoldsBack]);

  // The first row is the selection until the reader moves.
  useEffect(() => {
    if (!selectedId && ordered[0]) setSelectedId(ordered[0].id);
  }, [selectedId, ordered]);

  // Two keys inside one frame (a fast `jj`, a held key) both run before React
  // renders, so each step reads the selection it is moving from, not the render's.
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const move = useCallback((delta: number) => {
    setSelectedId((previous) => {
      const rows = orderedRef.current;
      if (rows.length === 0) return previous;
      const from = Math.max(rows.findIndex((row) => row.id === previous), 0);
      return rows[Math.min(Math.max(from + delta, 0), rows.length - 1)]!.id;
    });
  }, []);

  useKeyboard((key) => {
    if (!focused) return;
    if (pane === 'sheet') {
      if (sheetBusy) return;
      if (is(key, 'providers.back')) setPane('list');
      return;
    }
    if (filtering) {
      // The `<input>` owns typing; Enter keeps the filter, Esc clears it.
      if (is(key, 'providers.cancel')) {
        setSearch('');
        setFiltering(false);
      }
      if (is(key, 'providers.down')) move(1);
      if (is(key, 'providers.up')) move(-1);
      return;
    }
    if (is(key, 'providers.down')) return move(1);
    if (is(key, 'providers.up')) return move(-1);
    if (is(key, 'providers.first')) return setSelectedId(ordered[0]?.id ?? null);
    if (is(key, 'providers.last')) return setSelectedId(ordered.at(-1)?.id ?? null);
    if (is(key, 'providers.filter')) return setFiltering(true);
    if (is(key, 'providers.open') && selected) return setPane('sheet');
    if (is(key, 'providers.back')) {
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
  if (data.loading && ordered.length === 0) return <Spinner label="loading providers" />;

  const showList = split || pane === 'list';
  const showSheet = selected && entry && (split || pane === 'sheet');

  return (
    <box flexDirection="row" width={width} height={height}>
      {showList ? (
        <ProviderList
          inUse={inUse}
          available={available}
          total={data.catalogue.length + (data.managed ? 1 : 0)}
          selectedId={selected?.id ?? null}
          search={search}
          filtering={filtering && focused && pane === 'list'}
          onSearch={setSearch}
          onFilterDone={() => setFiltering(false)}
          active={pane === 'list'}
          note={
            data.pooled
              ? 'New API keys, ChatGPT and Claude accounts are private to you until you share them.'
              : data.canWrite
                ? null
                : 'Ask an owner of this workspace to add a key.'
          }
          width={listWidth}
          height={height}
        />
      ) : null}
      {split ? <box width={2} /> : null}
      {showSheet ? (
        <ProviderSheet
          key={entry.id}
          projectId={projectId}
          entry={entry}
          row={selected}
          data={data}
          focused={focused && pane === 'sheet'}
          width={sheetWidth}
          height={height}
          onToast={onToast}
          onBusy={setSheetBusy}
        />
      ) : null}
    </box>
  );
}

interface ProviderListProps {
  inUse: ProviderRow[];
  available: ProviderRow[];
  total: number;
  selectedId: string | null;
  search: string;
  filtering: boolean;
  onSearch(value: string): void;
  onFilterDone(): void;
  active: boolean;
  note: string | null;
  width: number;
  height: number;
}

function ProviderList({
  inUse,
  available,
  total,
  selectedId,
  search,
  filtering,
  onSearch,
  onFilterDone,
  active,
  note,
  width,
  height,
}: ProviderListProps) {
  const inner = Math.max(width - 1, 8);
  type Line = { key: string; text: string; fg: string; bold?: boolean };
  const lines: Line[] = [];
  const group = (label: string, rows: ProviderRow[]) => {
    if (rows.length === 0) return;
    lines.push({ key: `h-${label}`, text: label, fg: theme.faint });
    for (const row of rows) {
      const on = row.id === selectedId;
      const mark = row.status === 'none' ? ' ' : '✓';
      const right = row.disabled ? 'Turned off' : row.status === 'included' ? 'Included' : '';
      lines.push({
        key: row.id,
        text: layoutRow(`${on ? '›' : ' '} ${mark} ${row.label}`, right, inner),
        fg: on ? (active ? theme.accent : theme.fg) : row.status === 'none' ? theme.dim : theme.fg,
        bold: on,
      });
      if (on) lines.push({ key: `${row.id}-meta`, text: `     ${providerMeta(row)}`, fg: theme.faint });
    }
  };
  group(`In use · ${inUse.length}`, inUse);
  group('Available', available);

  // Keep the selection in view: the window starts so the selected row sits mid-list.
  const room = Math.max(height - 3 - (note ? 1 : 0), 3);
  const at = Math.max(lines.findIndex((line) => line.key === selectedId), 0);
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
            placeholder={`Search ${total} providers`}
            onInput={onSearch}
            onSubmit={onFilterDone}
          />
        ) : (
          <text fg={search ? theme.fg : theme.faint}>{search || `Search ${total} providers`}</text>
        )}
      </box>
      {note ? <text fg={theme.faint}>{note.length > inner ? `${note.slice(0, inner - 1)}…` : note}</text> : null}
      {lines.length === 0 ? <text fg={theme.faint}>{`No provider matches “${search.trim()}”`}</text> : null}
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
