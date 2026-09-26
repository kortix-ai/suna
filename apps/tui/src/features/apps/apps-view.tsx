/**
 * The Apps screen, as pixels and keys only.
 *
 * Everything drawn arrives as a prop and everything done leaves as a callback,
 * exactly like `features/sidebar/sidebar-view.tsx`. That split is what lets
 * `apps-view.test.tsx` assert real frames against fixture rows with no mocked
 * module, while `apps-screen.tsx` owns the SDK.
 *
 * Overlays are drawn IN the column, never as `ui/Modal`: `ui/panel.tsx` sets
 * `overflow: 'hidden'`, so an absolute overlay a panel's subtree draws is
 * scissored to that panel's rectangle (proved in wave 1 with
 * `scripts/dev-sidebar.tsx` + `SIDEBAR_NO_PANEL=1`).
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { matchesAppsBinding } from './keys.ts';

/** How an App reads at a glance. `tone` picks the glyph color, nothing else. */
export interface AppStatus {
  glyph: string;
  word: string;
  tone: 'ok' | 'idle' | 'busy' | 'bad';
}

export interface AppRow {
  id: string;
  name: string;
  /** The deployed origin. Empty when the App has never been deployed. */
  url: string;
  status: AppStatus;
  /** `App.access_mode`: private · project · restricted · public · password. */
  visibility: string;
  /** `App.updated_at` in epoch ms. */
  updatedMs: number;
}

/** The active deployment, fetched only while the details pane is open. */
export interface AppDetail {
  loading: boolean;
  version: number | null;
  deployStatus: string | null;
  deployedAtMs: number | null;
  provider: string | null;
  sourceKind: string | null;
  error: string | null;
  /** `2 vCPU · 4 GB RAM · 10 GB disk`, pre-formatted by the data half. */
  machine: string;
  idleTimeout: string;
  appId: string;
}

export interface AppsViewProps {
  rows: AppRow[];
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  /** Rendered in place of the list. The SDK error message, verbatim. */
  errorMessage: string | null;
  /** One dim line under the list: `stopping…`, `refreshing…`. */
  busyMessage?: string | null;
  /** The detail for the App whose details pane is open. */
  detail: AppDetail | null;
  /**
   * Access modes `v` offers. Empty means the caller cannot change visibility,
   * and the hint greys out instead of lying about a key that does nothing.
   */
  visibilityOptions?: readonly string[];
  /** True when the caller can start/stop. `d` greys out when false. */
  canChangeState?: boolean;
  /** Printed under the empty state: the command that creates the first App. */
  emptyHint?: string;
  /** `access_mode` → the phrase the web prints for it. */
  accessPhrase?: Record<string, string>;
  onSelect?(appId: string): void;
  /** `null` closes the pane. The caller fetches the detail for a non-null id. */
  onOpenDetails(appId: string | null): void;
  onOpenUrl(row: AppRow): void;
  onCopyUrl(row: AppRow): void;
  onRefresh(): void;
  onSetState(row: AppRow, next: 'running' | 'stopped'): void;
  onSetVisibility(row: AppRow, mode: string): void;
  /** Esc with nothing open. */
  onBack(): void;
}

/** The detail pane's label column. Wide enough for `Who can open` + a gap. */
const LABEL_WIDTH = 14;

const TONE_COLOR: Record<AppStatus['tone'], string> = {
  ok: theme.ok,
  idle: theme.faint,
  busy: theme.busy,
  bad: theme.danger,
};

/** The name column: a third of the width, never narrower than 12 columns. */
export function nameColumnWidth(width: number): number {
  return Math.min(Math.max(Math.floor(width * 0.34), 12), 32);
}

/**
 * One list row as plain text, cursor gutter excluded.
 *
 * `<glyph> <name padded>  <url truncated>   <status · age>`. Pure so the
 * layout is asserted directly instead of through a frame diff.
 */
export function appRowText(row: AppRow, now: number, width: number): string {
  const age = relativeAge(row.updatedMs, now);
  const right = age ? `${row.status.word} · ${age}` : row.status.word;
  const nameRoom = nameColumnWidth(width);
  const lead = `${row.status.glyph} `;
  const name =
    row.name.length > nameRoom ? `${row.name.slice(0, Math.max(nameRoom - 1, 0))}…` : row.name;
  const padded = name.padEnd(nameRoom, ' ');
  const url = row.url || 'not deployed';
  return layoutRow(`${lead}${padded} ${url}`, right, Math.max(width - 1, 0));
}

function Field({ label, value, fg }: { label: string; value: string; fg?: string }) {
  return (
    <text fg={fg ?? theme.fg}>
      <span fg={theme.faint}>{label.padEnd(LABEL_WIDTH, ' ')}</span>
      {value}
    </text>
  );
}

export function AppsView({
  rows,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  detail,
  visibilityOptions = [],
  canChangeState = true,
  emptyHint,
  accessPhrase = {},
  onSelect,
  onOpenDetails,
  onOpenUrl,
  onCopyUrl,
  onRefresh,
  onSetState,
  onSetVisibility,
  onBack,
}: AppsViewProps) {
  const [mode, setMode] = useState<'browse' | 'details' | 'confirm-state' | 'visibility'>('browse');
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.id ?? null);
  const [visibilityIndex, setVisibilityIndex] = useState(0);

  const cursorIndex = useMemo(() => {
    const found = rows.findIndex((row) => row.id === cursorId);
    return found >= 0 ? found : 0;
  }, [rows, cursorId]);
  const current = rows[cursorIndex] ?? null;

  const moveTo = useCallback(
    (index: number) => {
      if (rows.length === 0) return;
      const clamped = Math.min(Math.max(index, 0), rows.length - 1);
      const row = rows[clamped];
      if (!row) return;
      setCursorId(row.id);
      onSelect?.(row.id);
    },
    [rows, onSelect],
  );

  const closeOverlay = useCallback(() => {
    setMode('browse');
    onOpenDetails(null);
  }, [onOpenDetails]);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'confirm-state') {
      if (matchesAppsBinding(key, 'apps.back') || matchesAppsBinding(key, 'apps.deny')) {
        setMode('browse');
        return;
      }
      if (matchesAppsBinding(key, 'apps.confirm')) {
        const target = current;
        setMode('browse');
        if (target) onSetState(target, target.status.word === 'Running' ? 'stopped' : 'running');
      }
      return;
    }

    if (mode === 'visibility') {
      if (matchesAppsBinding(key, 'apps.back')) return setMode('browse');
      if (matchesAppsBinding(key, 'apps.down'))
        return setVisibilityIndex((index) => Math.min(index + 1, visibilityOptions.length - 1));
      if (matchesAppsBinding(key, 'apps.up'))
        return setVisibilityIndex((index) => Math.max(index - 1, 0));
      if (matchesAppsBinding(key, 'apps.details')) {
        const picked = visibilityOptions[visibilityIndex];
        const target = current;
        setMode('browse');
        if (target && picked) onSetVisibility(target, picked);
      }
      return;
    }

    if (mode === 'details') {
      if (matchesAppsBinding(key, 'apps.back')) return closeOverlay();
      if (matchesAppsBinding(key, 'apps.open')) {
        if (current) onOpenUrl(current);
        return;
      }
      if (matchesAppsBinding(key, 'apps.copy')) {
        if (current) onCopyUrl(current);
      }
      return;
    }

    if (matchesAppsBinding(key, 'apps.back')) return onBack();
    if (matchesAppsBinding(key, 'apps.down')) return moveTo(cursorIndex + 1);
    if (matchesAppsBinding(key, 'apps.up')) return moveTo(cursorIndex - 1);
    if (matchesAppsBinding(key, 'apps.first')) return moveTo(0);
    if (matchesAppsBinding(key, 'apps.last')) return moveTo(rows.length - 1);
    if (matchesAppsBinding(key, 'apps.refresh')) return onRefresh();
    if (matchesAppsBinding(key, 'apps.details')) {
      if (!current) return;
      setMode('details');
      onOpenDetails(current.id);
      return;
    }
    if (matchesAppsBinding(key, 'apps.open')) {
      if (current) onOpenUrl(current);
      return;
    }
    if (matchesAppsBinding(key, 'apps.copy')) {
      if (current) onCopyUrl(current);
      return;
    }
    if (matchesAppsBinding(key, 'apps.state')) {
      if (current && canChangeState) setMode('confirm-state');
      return;
    }
    if (matchesAppsBinding(key, 'apps.visibility')) {
      if (!current || visibilityOptions.length === 0) return;
      const at = visibilityOptions.indexOf(current.visibility);
      setVisibilityIndex(at >= 0 ? at : 0);
      setMode('visibility');
    }
  });

  const bodyWidth = Math.max(width - 1, 0);

  if (mode === 'details' && current) {
    const deployedAge = detail?.deployedAtMs ? relativeAge(detail.deployedAtMs, now) : null;
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>{layoutRow(current.name, current.status.word, bodyWidth)}</text>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        <Field label="URL" value={current.url || 'not deployed'} />
        <Field
          label="Who can open"
          value={
            accessPhrase[current.visibility]
              ? `${current.visibility} — ${accessPhrase[current.visibility]}`
              : current.visibility
          }
        />
        <Field
          label="Deployment"
          value={
            detail?.loading
              ? 'loading…'
              : detail?.version != null
                ? `v${detail.version} · ${detail.deployStatus ?? 'unknown'}`
                : 'none'
          }
        />
        <Field
          label="Deployed"
          value={deployedAge ? `${deployedAge} ago` : detail?.loading ? 'loading…' : '—'}
        />
        <Field label="Source" value={detail?.sourceKind ?? '—'} />
        <Field label="Provider" value={detail?.provider ?? '—'} />
        <Field label="Machine" value={detail?.machine ?? '—'} />
        <Field label="Idle stop" value={detail?.idleTimeout ?? '—'} />
        <Field label="App id" value={detail?.appId ?? current.id} />
        {detail?.error ? <Field label="Error" value={detail.error} fg={theme.danger} /> : null}
        <text fg={theme.faint}>Esc back · o open · y copy URL</text>
      </box>
    );
  }

  if (mode === 'visibility' && current) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>{layoutRow('Who may open this App', current.name, bodyWidth)}</text>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        {visibilityOptions.map((option, index) => (
          <text
            key={option}
            fg={index === visibilityIndex ? theme.fg : theme.dim}
            bg={index === visibilityIndex ? theme.surface : undefined}
          >
            <span fg={theme.accent}>{index === visibilityIndex ? GLYPH.selected : ' '}</span>
            {layoutRow(
              `${option} — ${accessPhrase[option] ?? option}`,
              option === current.visibility ? 'current' : '',
              bodyWidth - 1,
            )}
          </text>
        ))}
        <text fg={theme.faint}>Enter apply · Esc cancel</text>
      </box>
    );
  }

  const confirming = mode === 'confirm-state';
  const rowsAvailable = Math.max(height - (confirming ? 3 : 0) - (busyMessage ? 1 : 0) - 1, 1);
  const start = windowStart(cursorIndex, rows.length, rowsAvailable);
  const visible = rows.slice(start, start + rowsAvailable);
  const hints = [
    'Enter details',
    'o open',
    'y copy',
    canChangeState ? 'd start/suspend' : null,
    visibilityOptions.length > 0 ? 'v visibility' : null,
    'r refresh',
    'Esc back',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <box flexDirection="column" width={width}>
      {confirming && current ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.fg}>
            {current.status.word === 'Running' ? 'Suspend App' : 'Start App'}
          </text>
          <text fg={theme.fg}>{layoutRow(current.name, '', bodyWidth)}</text>
          <text fg={theme.faint}>y confirm · Esc cancel</text>
        </box>
      ) : null}

      {visible.map((row) => {
        const isCursor = row.id === current?.id;
        const body = appRowText(row, now, width);
        const mark = isCursor && focused ? GLYPH.selected : ' ';
        return (
          <text
            key={row.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.accent}>{mark}</span>
            <span fg={TONE_COLOR[row.status.tone]}>{body.slice(0, 2)}</span>
            {body.slice(2)}
          </text>
        );
      })}

      {loading && rows.length === 0 ? <Spinner label="loading Apps" /> : null}
      {!loading && !errorMessage && rows.length === 0 ? (
        <box flexDirection="column">
          <text fg={theme.fg}>No Apps yet</text>
          <text fg={theme.faint}>
            Deploy a static site, bundle, Dockerfile or OCI image from the project directory.
          </text>
          {emptyHint ? <text fg={theme.dim}>{`  ${emptyHint}`}</text> : null}
        </box>
      ) : null}
      {errorMessage ? (
        <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
      ) : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      {rows.length > 0 ? <text fg={theme.faint}>{hints}</text> : null}
    </box>
  );
}
