'use client';

/**
 * The read-only page of My Kortix, the built-in agent (slug `meta`).
 *
 * My Kortix is the one agent a person talks to. It runs the platform and every
 * other agent for them, with their own permissions in this project. This page
 * says what it does, what it can never do, and which agents it runs. Nothing
 * here is configurable: Kortix maintains its prompt, tools and model, and the
 * one project switch lives in kortix.yaml (`builtin_agents.my_kortix`).
 *
 * The page mounts only while My Kortix is on: with the switch off, /detail
 * does not list `meta`. Every capability state reads the viewer's own grants.
 *
 * It reads only what the agent page already loaded (project detail, the IAM
 * probe, the feature-flag map). No extra request.
 */

import type { ReactNode } from 'react';
import { CaretRightIcon } from '@phosphor-icons/react';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';
import { isMetaAgentName } from '@kortix/shared';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { EmptyState } from '../../primitives/empty-state';
import { StatusDot } from '../../primitives/status';
import { UiLink as Link } from '../../providers/ui-provider';
import {
  EditorList,
  EditorSection,
  SettingRow,
} from '../sections/view/agent-editor-primitives';

type Agent = ProjectConfigSummary['agents'][number];

/**
 * A row's state, right-aligned in the control column: the brand status
 * pattern, a dot that carries the hue and a word that stays ink. Green for a
 * capability the viewer holds; a muted dot for one that is off or withheld.
 */
function State({ on, label }: { on: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 sm:justify-end">
      <StatusDot tone={on ? 'success' : 'neutral'} />
      <span className={on ? 'text-foreground text-sm' : 'text-muted-foreground text-sm'}>
        {label}
      </span>
    </div>
  );
}

/** Literal text (a grant, a kortix.yaml key) inside a translated sentence. */
const code = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;

const NEVER = ['otherProjects', 'tokens', 'secrets', 'connectors'] as const;

export function PlatformAgentOverview({
  projectId,
  config,
}: {
  projectId: string;
  config: ProjectConfigSummary;
}) {
  const t = useI18nTranslations('agentEditor.myKortix');
  const canConfigure =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const canDelegate =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SESSION_START).allowed === true;
  const canBuildSpaces =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_GITOPS_MERGE).allowed === true;
  const goals = useFeatureFlag(projectId, 'goals').enabled;
  const agents = config.agents.filter((agent) => !agent.platform && !isMetaAgentName(agent.name));

  const allowed = (on: boolean) => <State on={on} label={on ? t('allowed') : t('notAllowed')} />;
  const denied = (grant: string) => t.rich('denied', { grant, code });

  return (
    <div className="space-y-8">
      <EditorSection title={t('capabilities.title')}>
        <SettingRow
          label={t('capabilities.configure.label')}
          help={canConfigure ? t('capabilities.configure.help') : denied('project.agent.write')}
        >
          {allowed(canConfigure)}
        </SettingRow>
        <SettingRow
          label={t('capabilities.delegate.label')}
          help={canDelegate ? t('capabilities.delegate.help') : denied('project.session.start')}
        >
          {allowed(canDelegate)}
        </SettingRow>
        <SettingRow label={t('capabilities.goals.label')} help={t('capabilities.goals.help')}>
          <State on={goals} label={goals ? t('on') : t('goalsOff')} />
        </SettingRow>
        <SettingRow
          label={t('capabilities.spaces.label')}
          help={canBuildSpaces ? t('capabilities.spaces.help') : denied('project.gitops.merge')}
        >
          {allowed(canBuildSpaces)}
        </SettingRow>
      </EditorSection>

      <EditorSection title={t('access.title')}>
        <SettingRow label={t('access.asYou.label')} help={t('access.asYou.help')}>
          <State on label={t('asYou')} />
        </SettingRow>
        {NEVER.map((row) => (
          <SettingRow key={row} label={t(`access.${row}.label`)} help={t(`access.${row}.help`)}>
            <State on={false} label={t('noAccess')} />
          </SettingRow>
        ))}
      </EditorSection>

      <EditorSection title={t('agents.title')} bare>
        {agents.length > 0 ? (
          <EditorList>
            {agents.map((agent) => (
              <AgentRow key={agent.name} projectId={projectId} agent={agent} />
            ))}
          </EditorList>
        ) : (
          <EmptyState size="sm" title={t('agents.empty')} />
        )}
      </EditorSection>

      <EditorSection title={t('project.title')}>
        <SettingRow label={t('project.label')} help={t.rich('project.help', { code })}>
          <State on label={t('on')} />
        </SettingRow>
      </EditorSection>
    </div>
  );
}

function AgentRow({ projectId, agent }: { projectId: string; agent: Agent }) {
  return (
    <li>
      <Link
        href={agentHref(projectId, agent.name)}
        className="hover:bg-hover focus-visible:bg-hover flex items-center gap-3 px-4 py-3 transition-colors focus-visible:outline-none"
      >
        <AgentMark slug={agent.name} />
        <div className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">
            {agentDisplayName(agent.name)}
          </span>
          {agent.description ? (
            <span className="text-muted-foreground block truncate text-xs">
              {agent.description}
            </span>
          ) : null}
        </div>
        <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      </Link>
    </li>
  );
}
