/**
 * Customize · Triggers.
 *
 * `useProjectTriggers` — cron, webhook and monitor triggers parsed out of the
 * project manifest. `Space`/`t` writes `enabled` through the same
 * `updateProjectTrigger` call the web's pause switch uses; the repo is the
 * source of truth, so that write commits to the manifest.
 *
 * Status wording is the web's (`schedule-copy.ts` `triggerStatus`):
 * `Active` / `Paused`.
 *
 * The web renders a cron expression as English ("Weekdays at 09:00"). This
 * prints the expression and its timezone instead — a terminal row has the
 * space, the expression is exact, and a second English renderer is a second
 * thing to keep in step with the first.
 */

import type { ProjectTrigger } from '@kortix/sdk';
import { useProjectTriggers } from '@kortix/sdk/react';
import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { List, type ListItem, Spinner } from '../../ui/index.ts';
import type { CustomizeTabProps } from './customize-screen.tsx';
import { DetailPane, Field, Paragraph } from './fields.tsx';
import { matchesCustomizeBinding } from './keys.ts';
import { errorText } from './use-project-detail.ts';

export interface TriggerRowData {
  slug: string;
  name: string;
  type: string;
  enabled: boolean;
  when: string;
  agent: string;
  model: string | null;
  sessionMode: string;
  webhookUrl: string | null;
  secretEnv: string | null;
  promptTemplate: string;
  lastFiredMs: number;
  path: string;
}

/** The one-line answer to "when does this run?". */
export function describeWhen(trigger: ProjectTrigger): string {
  if (trigger.type === 'webhook') return 'When a request arrives';
  if (trigger.type === 'monitor') {
    const mode = trigger.mode ?? 'poll';
    if (mode === 'poll' && trigger.interval_seconds)
      return `Monitor · every ${trigger.interval_seconds}s`;
    return `Monitor · ${mode}`;
  }
  if (trigger.run_at) return `Once at ${trigger.run_at}`;
  if (trigger.cron) return `${trigger.cron} (${trigger.timezone})`;
  return 'Custom timing';
}

export function triggerRows(triggers: ProjectTrigger[]): TriggerRowData[] {
  return triggers.map((trigger) => ({
    slug: trigger.slug,
    name: trigger.name || trigger.slug,
    type: trigger.type,
    enabled: trigger.enabled,
    when: describeWhen(trigger),
    agent: trigger.agent,
    model: trigger.model,
    sessionMode: trigger.session_mode,
    webhookUrl: trigger.webhook_url,
    secretEnv: trigger.secret_env,
    promptTemplate: trigger.prompt_template ?? '',
    lastFiredMs: Date.parse(trigger.last_fired_at ?? '') || Number.NaN,
    path: trigger.path,
  }));
}

export interface TriggersTabViewProps {
  rows: TriggerRowData[];
  /** Parse errors the listing endpoint reported, slug → message. */
  parseErrors?: Array<{ slug: string; error: string }>;
  /** The project-wide kill switch. True means nothing auto-runs. */
  paused?: boolean;
  focused: boolean;
  width: number;
  height: number;
  now: number;
  loading: boolean;
  errorMessage: string | null;
  busyMessage?: string | null;
  onToggle(slug: string, enabled: boolean): void;
  onInputActive(active: boolean): void;
}

export function TriggersTabView({
  rows,
  parseErrors = [],
  paused = false,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  onToggle,
  onInputActive,
}: TriggersTabViewProps) {
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.slug ?? null);
  const [detailOpen, setDetailOpen] = useState(false);
  const current = rows.find((row) => row.slug === cursorId) ?? rows[0] ?? null;

  const items = useMemo<ListItem[]>(
    () =>
      rows.map((row) => {
        const last = Number.isFinite(row.lastFiredMs)
          ? `${relativeAge(row.lastFiredMs, now)} ago`
          : 'Never';
        return {
          id: row.slug,
          glyph: row.enabled ? GLYPH.running : GLYPH.stopped,
          label: `${row.name} · ${row.when}`,
          right: `${row.enabled ? 'Active' : 'Paused'} · ${last}`,
          dim: !row.enabled,
        };
      }),
    [rows, now],
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
    if (matchesCustomizeBinding(key, 'customize.toggle')) {
      if (current) onToggle(current.slug, !current.enabled);
      return;
    }
    if (matchesCustomizeBinding(key, 'customize.open') && current) {
      setDetailOpen(true);
      onInputActive(true);
    }
  });

  if (detailOpen && current) {
    return (
      <DetailPane title={current.name} right={current.enabled ? 'Active' : 'Paused'} width={width}>
        <Field label="Type" value={current.type} />
        <Field label="When" value={current.when} />
        <Field label="Agent" value={current.agent} />
        <Field label="Model" value={current.model ?? 'project default'} />
        <Field label="Sessions" value={current.sessionMode} />
        <Field
          label="Last run"
          value={
            Number.isFinite(current.lastFiredMs)
              ? `${relativeAge(current.lastFiredMs, now)} ago`
              : 'Never'
          }
        />
        {current.type === 'webhook' ? (
          <>
            <Field label="Signed" value={current.secretEnv ? `yes (${current.secretEnv})` : 'no'} />
            <Field label="Address" value={current.webhookUrl ?? '—'} />
          </>
        ) : null}
        <Field label="Defined in" value={current.path} />
        <text fg={theme.faint}>Prompt</text>
        <Paragraph text={current.promptTemplate} width={Math.max(width - 2, 20)} maxLines={4} />
      </DetailPane>
    );
  }

  if (errorMessage) return <text fg={theme.danger}>{errorMessage}</text>;
  if (loading && rows.length === 0) return <Spinner label="loading triggers" />;

  const extraRows = (paused ? 1 : 0) + parseErrors.length + (busyMessage ? 1 : 0) + 1;

  return (
    <box flexDirection="column" width={width}>
      {paused ? (
        <text fg={theme.busy}>Triggers are paused for this project — nothing runs on its own.</text>
      ) : null}
      {parseErrors.map((entry) => (
        <text key={entry.slug} fg={theme.danger}>{`${entry.slug}: ${entry.error}`}</text>
      ))}
      <List
        items={items}
        focused={focused && !detailOpen}
        selectedId={current?.slug ?? null}
        onSelectedChange={setCursorId}
        onOpen={() => {
          setDetailOpen(true);
          onInputActive(true);
        }}
        maxRows={Math.max(height - extraRows, 1)}
        width={width}
        emptyText="No triggers yet. Declare them under triggers: in kortix.yaml."
      />
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      {rows.length > 0 ? (
        <text fg={theme.faint}>Space/t pause or resume · Enter details</text>
      ) : null}
    </box>
  );
}

export function TriggersTab({
  projectId,
  focused,
  width,
  height,
  now,
  onToast,
  onInputActive,
}: CustomizeTabProps) {
  const query = useProjectTriggers(projectId);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = useMemo(() => (query.data ? triggerRows(query.data.triggers) : []), [query.data]);

  const toggle = useCallback(
    (slug: string, enabled: boolean) => {
      setBusy(enabled ? 'resuming…' : 'pausing…');
      void query.update
        .mutateAsync({ slug, input: { enabled } })
        .then(() => onToast?.(`${slug} ${enabled ? 'resumed' : 'paused'}.`))
        .catch((error: unknown) => onToast?.(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [query.update, onToast],
  );

  return (
    <TriggersTabView
      rows={rows}
      parseErrors={query.data?.errors ?? []}
      paused={query.data?.triggers_paused === true}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={query.isLoading}
      errorMessage={query.isError ? errorText(query.error) : null}
      busyMessage={busy}
      onToggle={toggle}
      onInputActive={onInputActive}
    />
  );
}
