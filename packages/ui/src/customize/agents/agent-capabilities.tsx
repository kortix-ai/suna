'use client';

/**
 * The agent's built-in and project capabilities, one switch each (Marko,
 * 2026-10-27: "all the built-ins should be something you can turn on/off").
 * Three views of the agent page draw from one catalog, the API's
 * `GET /agents/:name/capabilities`:
 *
 *   Access → Skills       Project, then Built-in (folded)
 *   Access → Tools        Project, then Built-in: workspace, interaction, Kortix
 *   Access → Extensions   Project, then Built-in: platform (three always on)
 *
 * The switches write the agent's grant in the draft (`skills`, `tools`,
 * `extensions`) through `setCapabilityGranted`, so one item off under All is
 * `{ exclude: [id] }`, never an expanded list. Built-in skills are rows like
 * any other: choosing Specific keeps every row that is on.
 *
 * kortix_version 2 and 3. A v2 agent has no extension grant: its Extensions
 * view lists the platform extensions only.
 */

import {
  type AgentCapabilities,
  type AgentCapabilityGrant,
  capabilityGranted,
  setCapabilityGranted,
} from '@kortix/sdk';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { useAgentCapabilities } from '../../internal/hooks/projects/use-agent-config';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { UiLink as Link } from '../../providers/ui-provider';
import { type AgentGrant, type GrantMode, GrantModeTabs } from '../shared/agent-resource-scope';
import type { AgentDraft } from '../sections/view/agent-editor';
import { ManageButton } from '../sections/view/agent-editor-access-fields';
import { EditorList } from '../sections/view/agent-editor-primitives';
import { AccessGroup, type AccessItem, AccessLead, BuiltinGroup } from './agent-access-list';

export type CapabilityView = 'skills' | 'tools' | 'extensions';

/** What an omitted grant means: every tool, no v3 skill or extension. */
const OMITTED: Record<CapabilityView, 'all' | 'none'> = { tools: 'all', skills: 'none', extensions: 'none' };

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

function CatalogState({ query }: { query: ReturnType<typeof useAgentCapabilities> }) {
  const t = useI18nTranslations('agentCapabilities');
  if (query.isError) {
    return (
      <ErrorState
        size="sm"
        title={t('loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  }
  return (
    <EditorList>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex min-h-13 items-center gap-3 px-4 py-2">
          <Skeleton className="h-4 w-40 rounded-sm" />
        </li>
      ))}
    </EditorList>
  );
}

/** One view of the agent's capabilities, with the save bar's draft as its state. */
export function AgentCapabilitiesSection({
  view,
  projectId,
  agentName,
  editor,
  flagSettingsHref,
  schemaVersion,
}: {
  view: CapabilityView;
  /** The manifest version: project extensions exist from 3 on. */
  schemaVersion: number;
  projectId: string;
  agentName: string;
  editor: AgentDraft;
  /** Where a project feature flag is switched (Project admin → Feature flags). */
  flagSettingsHref: string;
}) {
  const t = useI18nTranslations('agentCapabilities');
  const tScope = useI18nTranslations('agentScope');
  const query = useAgentCapabilities(projectId, agentName);
  const catalog = query.data;
  const { draft } = editor;
  const body = catalog ? (
    view === 'skills' ? (
      <SkillsBody catalog={catalog} flagSettingsHref={flagSettingsHref} agentName={agentName} editor={editor} label={tScope('skillsAccess')} />
    ) : view === 'tools' ? (
      <ToolsBody catalog={catalog} editor={editor} agentName={agentName} />
    ) : (
      <ExtensionsBody catalog={catalog} editor={editor} agentName={agentName} label={t('extensionsAccess')} projectGrant={schemaVersion >= 3} />
    )
  ) : (
    <CatalogState query={query} />
  );
  return (
    <section className="space-y-6" data-testid={`agent-capabilities-${view}`} data-grant={JSON.stringify(draft[view] ?? null)}>
      <h2 className="sr-only">{t(`${view}Title`)}</h2>
      <AccessLead
        description={t(`${view}Description`)}
        action={view === 'skills' ? <ManageButton tab="skills" /> : undefined}
      />
      {body}
    </section>
  );
}

function SkillsBody({
  catalog,
  flagSettingsHref,
  agentName,
  editor,
  label,
}: {
  catalog: AgentCapabilities;
  flagSettingsHref: string;
  agentName: string;
  editor: AgentDraft;
  label: string;
}) {
  const t = useI18nTranslations('agentCapabilities');
  const value = editor.draft.skills;
  const write = (next: AgentCapabilityGrant) => editor.set('skills', next);
  const grant = capabilityModeGrant(value, catalog.skills.map((skill) => skill.id), OMITTED.skills, write);
  const rows = (group: 'builtin' | 'project'): AccessItem[] =>
    catalog.skills
      .filter((skill) => skill.group === group)
      .map((skill) => ({
        id: skill.id,
        description: skill.available ? (
          skill.description
        ) : (
          <>
            {t('flagOff')}{' '}
            <Link href={flagSettingsHref} className="text-foreground underline underline-offset-2">
              {t('flagSettings')}
            </Link>
          </>
        ),
        checked: skill.available && capabilityGranted(value, skill.id, OMITTED.skills),
        disabled: !skill.available,
        onCheckedChange: (on) => write(setCapabilityGranted(value, skill.id, on, OMITTED.skills)),
      }));
  const project = rows('project');
  return (
    <>
      <GrantModeTabs grant={grant} label={label} agentName={agentName} />
      <AccessGroup title={t('groups.project')} items={project} empty={t('emptyProjectSkills')} />
      <BuiltinGroup items={rows('builtin')} defaultOpen={project.length === 0} />
    </>
  );
}

/** The tool switch: its aliases go with it; codemode also clears `codemode: off`. */
function toolSwitch(editor: AgentDraft, id: string, aliases: string[]): Pick<AccessItem, 'checked' | 'onCheckedChange'> {
  const value = editor.draft.tools;
  const codemodeOff = id === 'codemode' && editor.draft.codemode === 'off';
  return {
    checked: !codemodeOff && capabilityGranted(value, id, OMITTED.tools),
    onCheckedChange: (on) => {
      editor.set('tools', setCapabilityGranted(value, [id, ...aliases], on, OMITTED.tools));
      if (on && codemodeOff) editor.set('codemode', undefined);
    },
  };
}

/** Built-in tools in the order an agent reaches for them. */
const BUILTIN_TOOL_GROUPS = ['workspace', 'interaction', 'kortix'] as const;

function ToolsBody({ catalog, editor, agentName }: { catalog: AgentCapabilities; editor: AgentDraft; agentName: string }) {
  const t = useI18nTranslations('agentCapabilities');
  const value = editor.draft.tools;
  const grant = capabilityModeGrant(
    value,
    catalog.tools.map((tool) => tool.id),
    OMITTED.tools,
    (next) => editor.set('tools', next),
  );
  const item = (tool: AgentCapabilities['tools'][number]): AccessItem => ({
    id: tool.id,
    description:
      tool.group === 'project'
        ? t('projectTool', { path: tool.source ?? '' })
        : tool.source
          ? `${tool.description ?? ''} ${t('replacedBy', { path: tool.source })}`
          : tool.description,
    ...toolSwitch(editor, tool.id, tool.aliases),
  });
  const project = catalog.tools.filter((tool) => tool.group === 'project').map(item);
  const builtin = BUILTIN_TOOL_GROUPS.flatMap((group) => catalog.tools.filter((tool) => tool.group === group).map(item));
  return (
    <>
      <GrantModeTabs grant={grant} label={t('toolsAccess')} agentName={agentName} />
      <AccessGroup title={t('groups.project')} items={project} empty={t('emptyProjectTools')} />
      <BuiltinGroup items={builtin} defaultOpen={project.length === 0} />
    </>
  );
}

function ExtensionsBody({
  catalog,
  editor,
  agentName,
  label,
  projectGrant,
}: {
  catalog: AgentCapabilities;
  editor: AgentDraft;
  agentName: string;
  label: string;
  /** False on v2: no `extensions` grant exists. */
  projectGrant: boolean;
}) {
  const t = useI18nTranslations('agentCapabilities');
  const value = editor.draft.extensions;
  const write = (next: AgentCapabilityGrant) => editor.set('extensions', next);
  const project = catalog.extensions.filter((ext) => ext.group === 'project');
  const grant = capabilityModeGrant(value, project.map((ext) => ext.id), OMITTED.extensions, write);
  const platform: AccessItem[] = catalog.extensions
    .filter((ext) => ext.group === 'platform')
    .map((ext) => {
      if (ext.required) {
        return {
          id: ext.id,
          description: ext.description,
          status: <span className="text-muted-foreground text-xs">{t('alwaysOn')}</span>,
        };
      }
      const tool = catalog.tools.find((candidate) => candidate.id === ext.controlled_by);
      return {
        id: ext.id,
        description: `${ext.description ?? ''} ${t('followsTool', { tool: ext.controlled_by ?? '' })}`,
        ...(tool ? toolSwitch(editor, tool.id, tool.aliases) : {}),
      };
    });
  const rows: AccessItem[] = project.map((ext) => ({
    id: ext.id,
    description: ext.description,
    checked: capabilityGranted(value, ext.id, OMITTED.extensions),
    onCheckedChange: (on) => write(setCapabilityGranted(value, ext.id, on, OMITTED.extensions)),
  }));
  return (
    <>
      {projectGrant && project.length > 0 ? <GrantModeTabs grant={grant} label={label} agentName={agentName} /> : null}
      {projectGrant ? <AccessGroup title={t('groups.project')} items={rows} empty={t('emptyProjectExtensions')} /> : null}
      <BuiltinGroup items={platform} defaultOpen={rows.length === 0} />
    </>
  );
}
