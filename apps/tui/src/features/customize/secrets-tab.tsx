/**
 * Customize · Secrets.
 *
 * Names only. `GET /projects/:id/secrets` never returns a value — not for a
 * manager, not for the owner — and this tab adds nothing that could leak one:
 * the add flow keeps the typed value in component state and renders `•` per
 * character, so the value never reaches the frame buffer OpenTUI paints or the
 * text `captureCharFrame()` reads back.
 *
 * Status wording is the web's (`secrets-view.tsx` `statusLabel`): a system row
 * reads `Managed by Kortix`, any other configured row reads `Set`, and a row
 * the manifest declares but nothing has filled reads `Not set`.
 */

import type { ProjectSecret } from '@kortix/sdk';
import { useProjectSecrets } from '@kortix/sdk/react';
import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { theme } from '../../theme.ts';
import { List, type ListItem, Spinner, layoutRow } from '../../ui/index.ts';
import type { CustomizeTabProps } from './customize-screen.tsx';
import { matchesCustomizeBinding } from './keys.ts';
import { errorText } from './use-project-detail.ts';

export interface SecretRowData {
  /** Unique per project. What `remove` takes. */
  identifier: string;
  /** The env var KEY. Printed only when it differs from the identifier. */
  name: string;
  status: 'Set' | 'Not set' | 'Managed by Kortix';
  /** A manifest-declared key with no row behind it cannot be deleted. */
  deletable: boolean;
  required: boolean;
  updatedMs: number;
}

export function secretStatus(secret: ProjectSecret): SecretRowData['status'] {
  if (secret.system) return secret.configured ? 'Managed by Kortix' : 'Not set';
  return secret.configured ? 'Set' : 'Not set';
}

/**
 * Stored secrets, plus every manifest key nothing has filled yet.
 *
 * The manifest's `required`/`optional` lists are env KEYS. A key already
 * covered by a stored row is not repeated; one that is not becomes a
 * `Not set` row, so a project states its whole contract in one list — the
 * same merge `apps/web`'s `buildRows` does.
 */
export function secretRows(response: {
  items: ProjectSecret[];
  required?: string[];
  optional?: string[];
}): SecretRowData[] {
  const required = new Set(response.required ?? []);
  const rows: SecretRowData[] = response.items.map((secret) => ({
    identifier: secret.identifier,
    name: secret.name,
    status: secretStatus(secret),
    deletable: !secret.system && !secret.readonly,
    required: required.has(secret.name),
    updatedMs: Date.parse(secret.updated_at ?? secret.created_at ?? '') || Number.NaN,
  }));
  const covered = new Set(response.items.map((secret) => secret.name));
  for (const key of [...(response.required ?? []), ...(response.optional ?? [])]) {
    if (covered.has(key)) continue;
    covered.add(key);
    rows.push({
      identifier: key,
      name: key,
      status: 'Not set',
      deletable: false,
      required: required.has(key),
      updatedMs: Number.NaN,
    });
  }
  return rows;
}

export interface SecretsTabViewProps {
  rows: SecretRowData[];
  focused: boolean;
  width: number;
  height: number;
  now: number;
  loading: boolean;
  errorMessage: string | null;
  busyMessage?: string | null;
  /** True when the caller may write shared rows. `n`/`d` grey out otherwise. */
  canManage?: boolean;
  onCreate(input: { name: string; value: string }): void;
  onDelete(identifier: string): void;
  onInputActive(active: boolean): void;
}

type Mode = 'browse' | 'name' | 'value' | 'confirm-delete';

export function SecretsTabView({
  rows,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  canManage = true,
  onCreate,
  onDelete,
  onInputActive,
}: SecretsTabViewProps) {
  const [mode, setMode] = useState<Mode>('browse');
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.identifier ?? null);
  const [draftName, setDraftName] = useState('');
  const [draftValue, setDraftValue] = useState('');

  const current = rows.find((row) => row.identifier === cursorId) ?? rows[0] ?? null;

  const items = useMemo<ListItem[]>(
    () =>
      rows.map((row) => {
        const age = Number.isFinite(row.updatedMs) ? relativeAge(row.updatedMs, now) : '';
        return {
          id: row.identifier,
          glyph: row.required && row.status === 'Not set' ? '*' : ' ',
          label: row.name === row.identifier ? row.identifier : `${row.identifier} → ${row.name}`,
          right: age ? `${row.status} · ${age}` : row.status,
          dim: row.status === 'Not set',
        };
      }),
    [rows, now],
  );

  const leave = useCallback(() => {
    setMode('browse');
    setDraftName('');
    setDraftValue('');
    onInputActive(false);
  }, [onInputActive]);

  const submitValue = useCallback(() => {
    const name = draftName.trim();
    const value = draftValue;
    leave();
    if (name && value) onCreate({ name, value });
  }, [draftName, draftValue, leave, onCreate]);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'name') {
      // The `<input>` owns every other key; Esc is the only chord still ours.
      if (matchesCustomizeBinding(key, 'customize.cancel')) leave();
      return;
    }

    if (mode === 'value') {
      // No `<input>` is mounted here on purpose: the value is captured by
      // hand so nothing ever echoes it into the frame.
      if (matchesCustomizeBinding(key, 'customize.cancel')) return leave();
      if (matchesCustomizeBinding(key, 'customize.submit')) return submitValue();
      if (key.name === 'backspace') {
        setDraftValue((value) => value.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.option && !key.meta && key.sequence && key.sequence.length === 1) {
        const code = key.sequence.charCodeAt(0);
        if (code >= 0x20 && code !== 0x7f) setDraftValue((value) => value + key.sequence);
      }
      return;
    }

    if (mode === 'confirm-delete') {
      if (matchesCustomizeBinding(key, 'customize.cancel')) return leave();
      if (matchesCustomizeBinding(key, 'customize.deny')) return leave();
      if (matchesCustomizeBinding(key, 'customize.confirm')) {
        const target = current;
        leave();
        if (target) onDelete(target.identifier);
      }
      return;
    }

    if (matchesCustomizeBinding(key, 'customize.new')) {
      if (!canManage) return;
      setDraftName('');
      setDraftValue('');
      setMode('name');
      onInputActive(true);
      return;
    }
    if (matchesCustomizeBinding(key, 'customize.delete')) {
      if (!canManage || !current?.deletable) return;
      setMode('confirm-delete');
      onInputActive(true);
    }
  });

  const bodyWidth = Math.max(width - 1, 0);

  if (mode === 'name') {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>New secret — name</text>
        <text fg={theme.faint}>The env var key, e.g. STRIPE_API_KEY.</text>
        <box flexDirection="row" width={width}>
          <text fg={theme.accent}>{'▌'}</text>
          <input
            focused
            flexGrow={1}
            value={draftName}
            placeholder="SECRET_NAME"
            onInput={setDraftName}
            onSubmit={() => {
              if (!draftName.trim()) return;
              setMode('value');
            }}
          />
        </box>
        <text fg={theme.faint}>Enter next · Esc cancel</text>
      </box>
    );
  }

  if (mode === 'value') {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>{layoutRow('New secret — value', draftName.trim(), bodyWidth)}</text>
        <text fg={theme.faint}>The value is masked and is never printed.</text>
        <text fg={theme.fg}>
          <span fg={theme.accent}>{'▌'}</span>
          {draftValue ? '•'.repeat(draftValue.length) : ''}
        </text>
        <text fg={theme.faint}>Enter save · Esc cancel</text>
      </box>
    );
  }

  if (errorMessage) return <text fg={theme.danger}>{errorMessage}</text>;
  if (loading && rows.length === 0) return <Spinner label="loading secrets" />;

  const confirming = mode === 'confirm-delete';
  const hints = [canManage ? 'n add' : null, canManage ? 'd delete' : null, '* required']
    .filter(Boolean)
    .join(' · ');

  return (
    <box flexDirection="column" width={width}>
      {confirming && current ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.danger}>Delete secret</text>
          <text fg={theme.fg}>{layoutRow(current.identifier, '', bodyWidth)}</text>
          <text fg={theme.faint}>y delete · Esc cancel</text>
        </box>
      ) : null}
      <List
        items={items}
        focused={focused && mode === 'browse'}
        selectedId={current?.identifier ?? null}
        onSelectedChange={setCursorId}
        maxRows={Math.max(height - (confirming ? 4 : 1) - (busyMessage ? 1 : 0), 1)}
        width={width}
        emptyText="No secrets in this project yet."
      />
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      <text fg={theme.faint}>{hints}</text>
    </box>
  );
}

export function SecretsTab({
  projectId,
  focused,
  width,
  height,
  now,
  onToast,
  onInputActive,
}: CustomizeTabProps) {
  const query = useProjectSecrets(projectId);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = useMemo(() => (query.data ? secretRows(query.data) : []), [query.data]);

  const create = useCallback(
    (input: { name: string; value: string }) => {
      setBusy('saving…');
      void query.upsert
        .mutateAsync(input)
        .then(() => onToast?.(`${input.name} saved.`))
        .catch((error: unknown) => onToast?.(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [query.upsert, onToast],
  );

  const remove = useCallback(
    (identifier: string) => {
      setBusy('deleting…');
      void query.remove
        .mutateAsync(identifier)
        .then(() => onToast?.(`${identifier} deleted.`))
        .catch((error: unknown) => onToast?.(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [query.remove, onToast],
  );

  return (
    <SecretsTabView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={query.isLoading}
      errorMessage={query.isError ? errorText(query.error) : null}
      busyMessage={busy}
      canManage={query.data?.can_manage !== false}
      onCreate={create}
      onDelete={remove}
      onInputActive={onInputActive}
    />
  );
}
