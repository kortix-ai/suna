'use client';

/**
 * The agent's built-in and project capabilities, one switch each (Marko,
 * 2026-10-27: "all the built-ins should be something you can turn on/off").
 * Three views of the agent page draw from one catalog, the API's
 * `GET /agents/:name/capabilities`:
 *
 *   Access → Skills       Built-in, Project
 *   Runtime → Tools       Workspace, Interaction, Kortix, Project
 *   Access → Extensions   Platform (three always on), Project
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
import type { ReactNode } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { useAgentCapabilities } from '../../internal/hooks/projects/use-agent-config';
import { cn } from '../../internal/lib/utils';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { Switch } from '../../primitives/switch';
import { UiLink as Link } from '../../providers/ui-provider';
import { type AgentGrant, type GrantMode, GrantModeTabs } from '../shared/agent-resource-scope';
import type { AgentDraft } from '../sections/view/agent-editor';
import { ManageButton } from '../sections/view/agent-editor-access-fields';
import { EditorList, EditorSection } from '../sections/view/agent-editor-primitives';

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

interface Row {
  id: string;
  description: ReactNode;
  /** Absent: the row shows a mark instead of a switch. */
  checked?: boolean;
  onCheckedChange?: (on: boolean) => void;
  disabled?: boolean;
  status?: ReactNode;
}

function CapabilityRows({ rows, empty }: { rows: Row[]; empty?: string }) {
  const t = useI18nTranslations('agentCapabilities');
  if (rows.length === 0) return empty ? <p className="text-muted-foreground px-1 text-sm">{empty}</p> : null;
  return (
    <EditorList>
      {rows.map((row) => (
        <li
          key={row.id}
          data-capability={row.id}
          className={cn('flex min-h-13 items-center gap-3 px-4 py-2', row.disabled && 'opacity-60')}
        >
          <span className="min-w-0 flex-1">
            <span className="text-foreground block truncate font-mono text-sm">{row.id}</span>
            {/* A Kortix skill's description is its routing text for the model,
                often a paragraph: two lines here, the whole text on hover. */}
            {row.description ? (
              <span
                className="text-muted-foreground line-clamp-2 text-xs text-pretty"
                title={typeof row.description === 'string' ? row.description : undefined}
              >
                {row.description}
              </span>
            ) : null}
          </span>
          {row.status ? <span className="flex shrink-0 items-center gap-2">{row.status}</span> : null}
          {row.onCheckedChange ? (
            <Switch
              checked={row.checked ?? false}
              disabled={row.disabled}
              onCheckedChange={row.onCheckedChange}
              aria-label={t('toggle', { name: row.id })}
            />
          ) : null}
        </li>
      ))}
    </EditorList>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <EditorSection title={title} bare>
      {children}
    </EditorSection>
  );
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
  const title = t(`${view}Title`);
  const body = catalog ? (
    view === 'skills' ? (
      <SkillsBody catalog={catalog} flagSettingsHref={flagSettingsHref} agentName={agentName} editor={editor} label={tScope('skillsAccess')} />
    ) : view === 'tools' ? (
      <ToolsBody catalog={catalog} editor={editor} />
    ) : (
      <ExtensionsBody catalog={catalog} editor={editor} agentName={agentName} label={t('extensionsAccess')} projectGrant={schemaVersion >= 3} />
    )
  ) : (
    <CatalogState query={query} />
  );
  return (
    <EditorSection
      title={title}
      description={t(`${view}Description`)}
      trailing={view === 'skills' ? <ManageButton tab="skills" /> : undefined}
      lead
      bare
    >
      <div className="space-y-6" data-testid={`agent-capabilities-${view}`} data-grant={JSON.stringify(draft[view] ?? null)}>
        {body}
      </div>
    </EditorSection>
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
  const rows = (group: 'builtin' | 'project'): Row[] =>
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
  return (
    <>
      <GrantModeTabs grant={grant} label={label} agentName={agentName} />
      <Group title={t('groups.builtin')}>
        <CapabilityRows rows={rows('builtin')} />
      </Group>
      <Group title={t('groups.project')}>
        <CapabilityRows rows={rows('project')} empty={t('emptyProjectSkills')} />
      </Group>
    </>
  );
}

/** The tool switch: its aliases go with it; codemode also clears `codemode: off`. */
function toolSwitch(editor: AgentDraft, id: string, aliases: string[]): Pick<Row, 'checked' | 'onCheckedChange'> {
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

function ToolsBody({ catalog, editor }: { catalog: AgentCapabilities; editor: AgentDraft }) {
  const t = useI18nTranslations('agentCapabilities');
  const groups = ['workspace', 'interaction', 'kortix', 'project'] as const;
  return (
    <>
      {groups.map((group) => {
        const rows: Row[] = catalog.tools
          .filter((tool) => tool.group === group)
          .map((tool) => ({
            id: tool.id,
            description:
              tool.group === 'project'
                ? t('projectTool', { path: tool.source ?? '' })
                : tool.source
                  ? `${tool.description ?? ''} ${t('replacedBy', { path: tool.source })}`
                  : tool.description,
            ...toolSwitch(editor, tool.id, tool.aliases),
          }));
        if (rows.length === 0) return null;
        return (
          <Group key={group} title={t(`groups.${group}`)}>
            <CapabilityRows rows={rows} />
          </Group>
        );
      })}
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
  const platform: Row[] = catalog.extensions
    .filter((ext) => ext.group === 'platform')
    .map((ext) => {
      if (ext.required) {
        return {
          id: ext.id,
          description: ext.description,
          status: (
            <Badge variant="muted" size="xs">
              {t('alwaysOn')}
            </Badge>
          ),
        };
      }
      const tool = catalog.tools.find((candidate) => candidate.id === ext.controlled_by);
      return {
        id: ext.id,
        description: `${ext.description ?? ''} ${t('followsTool', { tool: ext.controlled_by ?? '' })}`,
        ...(tool ? toolSwitch(editor, tool.id, tool.aliases) : {}),
      };
    });
  const rows: Row[] = project.map((ext) => ({
    id: ext.id,
    description: ext.description,
    checked: capabilityGranted(value, ext.id, OMITTED.extensions),
    onCheckedChange: (on) => write(setCapabilityGranted(value, ext.id, on, OMITTED.extensions)),
  }));
  return (
    <>
      <Group title={t('groups.platform')}>
        <CapabilityRows rows={platform} />
      </Group>
      {projectGrant ? (
        <Group title={t('groups.project')}>
          <div className="space-y-3">
            {project.length > 0 ? <GrantModeTabs grant={grant} label={label} agentName={agentName} /> : null}
            <CapabilityRows rows={rows} empty={t('emptyProjectExtensions')} />
          </div>
        </Group>
      ) : null}
    </>
  );
}
