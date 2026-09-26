/**
 * Customize · Skills.
 *
 * `ProjectConfigSummary.skills` — the same server-side read
 * `apps/web/src/features/workspace/capabilities/skills/skills-page.tsx` uses.
 * Skills do NOT require a session: they are project config, so this tab works
 * with no sandbox running. That is why `CustomizeScreen` takes no session
 * prop.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { theme } from '../../theme.ts';
import { List, type ListItem, Spinner } from '../../ui/index.ts';
import type { CustomizeTabProps } from './customize-screen.tsx';
import { DetailPane, Field, Paragraph } from './fields.tsx';
import { matchesCustomizeBinding } from './keys.ts';
import { useProjectDetailState } from './use-project-detail.ts';

export interface SkillRowData {
  name: string;
  path: string;
  description: string | null;
  /** `kortix` for a baked platform skill, `project` for one in the repo. */
  scope: 'project' | 'kortix';
}

/**
 * Where a skill comes from.
 *
 * The web splits the same list into All / Project / Kortix. A baked platform
 * skill lives under a `.kortix` path inside the sandbox image; anything under
 * the repo's own `.opencode` tree is the project's.
 */
export function skillScope(path: string): SkillRowData['scope'] {
  return /(^|\/)\.kortix(\/|$)/.test(path) ? 'kortix' : 'project';
}

export function skillRows(config: {
  skills: Array<{ name: string; path: string; description: string | null }>;
}): SkillRowData[] {
  return config.skills.map((skill) => ({
    name: skill.name,
    path: skill.path,
    description: skill.description,
    scope: skillScope(skill.path),
  }));
}

export interface SkillsTabViewProps {
  rows: SkillRowData[];
  focused: boolean;
  width: number;
  height: number;
  loading: boolean;
  errorMessage: string | null;
  onInputActive(active: boolean): void;
}

export function SkillsTabView({
  rows,
  focused,
  width,
  height,
  loading,
  errorMessage,
  onInputActive,
}: SkillsTabViewProps) {
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.path ?? null);
  const [detailOpen, setDetailOpen] = useState(false);
  const current = rows.find((row) => row.path === cursorId) ?? rows[0] ?? null;

  const items = useMemo<ListItem[]>(
    () =>
      rows.map((row) => ({
        id: row.path,
        label: row.description ? `${row.name} · ${row.description}` : row.name,
        right: row.scope,
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
      <DetailPane title={current.name} right={current.scope} width={width}>
        <Field label="Defined in" value={current.path} />
        <Paragraph
          text={current.description ?? 'No description.'}
          width={Math.max(width - 2, 20)}
          maxLines={6}
        />
      </DetailPane>
    );
  }

  if (errorMessage) return <text fg={theme.danger}>{errorMessage}</text>;
  if (loading && rows.length === 0) return <Spinner label="loading skills" />;

  return (
    <box flexDirection="column" width={width}>
      <List
        items={items}
        focused={focused && !detailOpen}
        selectedId={current?.path ?? null}
        onSelectedChange={setCursorId}
        onOpen={() => {
          setDetailOpen(true);
          onInputActive(true);
        }}
        maxRows={Math.max(height - 1, 1)}
        width={width}
        emptyText="No skills yet. Add one under .opencode/skill/<name>/SKILL.md."
      />
      {rows.length > 0 ? <text fg={theme.faint}>Enter details</text> : null}
    </box>
  );
}

export function SkillsTab({ projectId, focused, width, height, onInputActive }: CustomizeTabProps) {
  const detail = useProjectDetailState(projectId);
  const rows = useMemo(() => (detail.config ? skillRows(detail.config) : []), [detail.config]);
  return (
    <SkillsTabView
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
