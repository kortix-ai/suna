'use client';

/**
 * Skills, Tools and Extensions: ONE component each, in two modes (Marko,
 * 2026-10-27: "no double components, one component with either mode,
 * agent-based or project-wide").
 *
 *  - **Project** (Project admin): the project's catalog. The project's own
 *    items first, then what Kortix ships in a quiet fold. Skills adds New,
 *    each skill's files, and Remove.
 *  - **Agent** (the agent page's Access tab): the same list, plus the
 *    All · Specific · None row and one switch per row writing the agent's
 *    grant (`skills`, `tools`, `extensions`) into the page's draft. One item
 *    off under All is `{ exclude: [id] }`, never an expanded list.
 *
 * The catalog is the project's (`GET /projects/:id/capabilities`): the same
 * list in both modes, so the two can never disagree.
 */

import {
  type AgentCapabilityGrant,
  type ProjectCapabilities,
  capabilityGranted,
  getProjectDetail,
  setCapabilityGranted,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { useProjectCapabilities } from '../../internal/hooks/projects/use-agent-config';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { adminPath } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Skeleton } from '../../primitives/skeleton';
import { UiLink as Link } from '../../providers/ui-provider';
import { AccessGroup, type AccessItem, BuiltinGroup } from './access-list';
import type { AgentDraft } from '../sections/view/agent-editor';
import { EditorList } from '../sections/view/agent-editor-primitives';
import { NewSkillModal } from '../skills/new-skill-modal';
import { newConfigPrompt, useConfigureThread } from '../use-configure-thread';
import { type AgentGrant, type GrantMode, GrantModeTabs } from './agent-resource-scope';
import { CapabilityPageShell } from './capability-page-shell';
import { detailSelection } from './detail-selection';
import { EntityDetailModal } from './entity/entity-modal';
import { NewEntityMenu } from './new-entity-menu';

export type CapabilityView = 'skills' | 'tools' | 'extensions';

/** What an omitted grant means: every tool, no v3 skill or extension. */
const OMITTED: Record<CapabilityView, 'all' | 'none'> = { tools: 'all', skills: 'none', extensions: 'none' };

/** Built-in tools in the order an agent reaches for them. */
const BUILTIN_TOOL_GROUPS = ['workspace', 'interaction', 'kortix'] as const;

/** Agent mode: whose grant the switches write, and the page's draft that holds it. */
export interface CapabilityAgent {
  name: string;
  editor: AgentDraft;
  /** The manifest version: an agent's extension grant exists from 3 on. */
  schemaVersion: number;
}

/**
 * The All · Specific · None select over a capability grant. `{ exclude }`
 * reads as All. Specific keeps every id that is on now, so a built-in row
 * that was on stays on.
 */
export function capabilityModeGrant(
  value: AgentCapabilityGrant | undefined,
  ids: readonly string[],
  omitted: 'all' | 'none',
  onChange: (next: AgentCapabilityGrant) => void,
): AgentGrant {
  const current = value ?? omitted;
  const mode: GrantMode = Array.isArray(current) ? (current.length > 0 ? 'specific' : 'none') : current === 'none' ? 'none' : 'all';
  return {
    value: Array.isArray(current) || typeof current === 'string' ? current : 'all',
    mode,
    isGranted: (id) => capabilityGranted(value, id, omitted),
    toggle: (id) => onChange(setCapabilityGranted(value, id, !capabilityGranted(value, id, omitted), omitted)),
    setMode: (next) => {
      if (next === 'all') return onChange('all');
      if (next === 'none') return onChange('none');
      const on = ids.filter((id) => capabilityGranted(value, id, omitted));
      onChange(on.length > 0 ? on : 'none');
    },
  };
}

/** One row per catalog item, in the order the view draws them: the project's, then Kortix's. */
function catalogRows(
  view: CapabilityView,
  catalog: ProjectCapabilities,
  t: ReturnType<typeof useI18nTranslations>,
): { project: AccessItem[]; builtin: AccessItem[]; ids: string[] } {
  if (view === 'skills') {
    const item = (skill: ProjectCapabilities['skills'][number]): AccessItem => ({ id: skill.id, description: skill.description, disabled: !skill.available });
    return {
      project: catalog.skills.filter((s) => s.group === 'project').map(item),
      builtin: catalog.skills.filter((s) => s.group === 'builtin').map(item),
      ids: catalog.skills.map((s) => s.id),
    };
  }
  if (view === 'tools') {
    const item = (tool: ProjectCapabilities['tools'][number]): AccessItem => ({
      id: tool.id,
      description:
        tool.group === 'project'
          ? t('projectTool', { path: tool.source ?? '' })
          : tool.source
            ? `${tool.description ?? ''} ${t('replacedBy', { path: tool.source })}`
            : tool.description,
    });
    return {
      project: catalog.tools.filter((tool) => tool.group === 'project').map(item),
      builtin: BUILTIN_TOOL_GROUPS.flatMap((group) => catalog.tools.filter((tool) => tool.group === group).map(item)),
      ids: catalog.tools.map((tool) => tool.id),
    };
  }
  const item = (ext: ProjectCapabilities['extensions'][number]): AccessItem => ({
    id: ext.id,
    description: ext.controlled_by ? `${ext.description ?? ''} ${t('followsTool', { tool: ext.controlled_by })}` : ext.description,
    status: ext.required ? <span className="text-muted-foreground text-xs">{t('alwaysOn')}</span> : undefined,
  });
  return {
    project: catalog.extensions.filter((ext) => ext.group === 'project').map(item),
    builtin: catalog.extensions.filter((ext) => ext.group === 'platform').map(item),
    ids: catalog.extensions.filter((ext) => ext.group === 'project').map((ext) => ext.id),
  };
}

/**
 * Agent mode: give each row its switch. A tool switch carries its aliases,
 * and codemode also clears `codemode: off`. A platform extension follows its
 * tool's switch; a required one has none.
 */
function withSwitches(
  view: CapabilityView,
  rows: AccessItem[],
  catalog: ProjectCapabilities,
  editor: AgentDraft,
): AccessItem[] {
  const toolSwitch = (id: string, aliases: string[]): Pick<AccessItem, 'checked' | 'onCheckedChange'> => {
    const value = editor.draft.tools;
    const codemodeOff = id === 'codemode' && editor.draft.codemode === 'off';
    return {
      checked: !codemodeOff && capabilityGranted(value, id, OMITTED.tools),
      onCheckedChange: (on) => {
        editor.set('tools', setCapabilityGranted(value, [id, ...aliases], on, OMITTED.tools));
        if (on && codemodeOff) editor.set('codemode', undefined);
      },
    };
  };
  return rows.map((row) => {
    if (view === 'tools') {
      const tool = catalog.tools.find((x) => x.id === row.id);
      return { ...row, ...toolSwitch(row.id, tool?.aliases ?? []) };
    }
    if (view === 'extensions') {
      const ext = catalog.extensions.find((x) => x.id === row.id);
      if (!ext || ext.required) return row;
      if (ext.group === 'platform') {
        const tool = catalog.tools.find((x) => x.id === ext.controlled_by);
        return tool ? { ...row, ...toolSwitch(tool.id, tool.aliases) } : row;
      }
    }
    const key = view === 'skills' ? 'skills' : 'extensions';
    const value = editor.draft[key];
    return {
      ...row,
      checked: !row.disabled && capabilityGranted(value, row.id, OMITTED[view]),
      onCheckedChange: (on) => editor.set(key, setCapabilityGranted(value, row.id, on, OMITTED[view])),
    };
  });
}

const VIEW_COPY: Record<CapabilityView, { title: string; access: string }> = {
  skills: { title: 'skillsTitle', access: 'skillsAccess' },
  tools: { title: 'toolsTitle', access: 'toolsAccess' },
  extensions: { title: 'extensionsTitle', access: 'extensionsAccess' },
};

/** Skills, Tools or Extensions, project-wide or for one agent. */
export function CapabilityLibrary({
  projectId,
  view,
  agent,
  footer,
}: {
  projectId: string;
  view: CapabilityView;
  /** Absent: the project's catalog (Project admin). Present: this agent's grant over it. */
  agent?: CapabilityAgent;
  /** Below the list: Tools' approval rules on an agent's page. */
  footer?: ReactNode;
}) {
  const t = useI18nTranslations('agentCapabilities');
  const query = useProjectCapabilities(projectId);
  const catalog = query.data;
  const [search, setSearch] = useState('');
  const skills = useSkillManagement(projectId, view === 'skills');

  const rows = useMemo(() => (catalog ? catalogRows(view, catalog, t) : null), [catalog, view, t]);
  const match = (row: AccessItem) => {
    const q = search.trim().toLowerCase();
    return !q || row.id.toLowerCase().includes(q) || String(row.description ?? '').toLowerCase().includes(q);
  };

  let project = rows?.project.filter(match) ?? [];
  let builtin = rows?.builtin.filter(match) ?? [];
  if (view === 'skills') {
    // A flagged built-in skill whose flag is off says so, with the way to turn it on.
    builtin = builtin.map((row) =>
      row.disabled
        ? {
            ...row,
            description: (
              <>
                {t('flagOff')}{' '}
                <Link href={adminPath(projectId, 'feature-flags')} className="text-foreground underline underline-offset-2">
                  {t('flagSettings')}
                </Link>
              </>
            ),
          }
        : row,
    );
    project = project.map((row) => ({ ...row, onOpen: skills.open(row.id) }));
  }
  const extensionGrant = view !== 'extensions' || (agent?.schemaVersion ?? 3) >= 3;
  if (agent && catalog) {
    if (extensionGrant) project = withSwitches(view, project, catalog, agent.editor);
    builtin = withSwitches(view, builtin, catalog, agent.editor);
  }

  const grant =
    agent && rows && extensionGrant && (view !== 'extensions' || rows.project.length > 0)
      ? capabilityModeGrant(
          agent.editor.draft[view],
          rows.ids,
          OMITTED[view],
          (next) => agent.editor.set(view, next),
        )
      : null;

  const empty = view === 'skills' ? t('emptyProjectSkills') : view === 'tools' ? t('emptyProjectTools') : t('emptyProjectExtensions');
  const body = catalog ? (
    <div className="space-y-6" data-testid={`capability-library-${view}`} data-grant={agent ? JSON.stringify(agent.editor.draft[view] ?? null) : undefined}>
      {view !== 'extensions' || extensionGrant ? <AccessGroup title={t('groups.project')} items={project} empty={search ? t('noMatch') : empty} /> : null}
      <BuiltinGroup items={builtin} defaultOpen={project.length === 0 || !!search.trim()} />
    </div>
  ) : query.isError ? (
    <ErrorState
      size="sm"
      title={t('loadError')}
      action={
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t('retry')}
        </Button>
      }
    />
  ) : (
    <EditorList>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex min-h-12 items-center gap-3 px-4 py-2">
          <Skeleton className="h-4 w-40 rounded-sm" />
        </li>
      ))}
    </EditorList>
  );

  return (
    <CapabilityPageShell
      title={t(VIEW_COPY[view].title)}
      description={agent ? t(`${view}Description`) : t(`${view}ProjectDescription`)}
      action={skills.createButton}
      search={
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={t(`${view}Search`)}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            size="sm"
          />
          {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
        </InputGroupSearch>
      }
      filters={grant && agent ? <GrantModeTabs grant={grant} label={t(VIEW_COPY[view].access)} agentName={agent.name} /> : undefined}
    >
      {body}
      {footer}
      {skills.modals}
    </CapabilityPageShell>
  );
}

/** Skills' own controls, in both modes: New (chat or form), each skill's files, Remove. */
function useSkillManagement(projectId: string, on: boolean) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const accountId = useProjectAccountId(projectId);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SKILL_WRITE, { accountId }).allowed === true;
  const configure = useConfigureThread(projectId);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: on,
    ...contract('config'),
  });
  const skills = detailQuery.data?.config.skills ?? [];
  const detail = detailSelection({
    selection: selectedName,
    record: skills.find((skill) => skill.name === selectedName),
    isSuccess: detailQuery.isSuccess,
  });
  // The config came back without this skill: it really was removed or renamed.
  if (detail.isMissing) setSelectedName(null);
  if (!on) return { createButton: undefined, modals: null, open: () => undefined };
  return {
    open: (name: string) => () => setSelectedName(name),
    createButton: canWrite ? (
      <NewEntityMenu
        label="New"
        pending={configure.pending}
        onChat={() => configure.start(newConfigPrompt('skill'))}
        manual={{
          label: tI18nComplete.raw('texta38668224f1a'),
          description: tI18nComplete.raw('textedac6130dac7'),
          onSelect: () => setFormOpen(true),
        }}
      />
    ) : undefined,
    modals: (
      <>
        <EntityDetailModal
          projectId={projectId}
          entity={detail.record}
          kind="skill"
          removable
          open={detail.open}
          isResolving={detail.isResolving}
          onOpenChange={(next) => {
            if (!next) setSelectedName(null);
          }}
        />
        <NewSkillModal projectId={projectId} open={formOpen} onOpenChange={setFormOpen} />
      </>
    ),
  };
}
