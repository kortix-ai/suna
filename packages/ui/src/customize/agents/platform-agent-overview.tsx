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
 * It reads only what the agent page already loaded (project detail, the IAM
 * probe, the feature-flag map). No extra request.
 */

import { CaretRightIcon } from '@phosphor-icons/react';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';
import { capitalizeWords, isMetaAgentName } from '@kortix/shared';

import { AgentMark } from '../../internal/components/agent-mark';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Badge } from '../../primitives/badge';
import { EmptyState } from '../../primitives/empty-state';
import { UiLink as Link } from '../../providers/ui-provider';
import {
  EditorList,
  EditorSection,
  SettingRow,
} from '../sections/view/agent-editor-primitives';

type Agent = ProjectConfigSummary['agents'][number];

/** A row's state, right-aligned in the control column. */
function State({ on, label }: { on: boolean; label: string }) {
  return (
    <div className="flex sm:justify-end">
      <Badge variant={on ? 'success' : 'muted'} size="sm">
        {label}
      </Badge>
    </div>
  );
}

const NEVER = [
  {
    label: 'Other projects and account settings',
    help: 'Its access ends at this project.',
  },
  {
    label: 'New tokens',
    help: 'It cannot mint a credential for itself or anyone else.',
  },
  {
    label: 'Project secrets',
    help: 'An agent granted the secret uses it instead.',
  },
  {
    label: 'Direct connector calls',
    help: 'It hands connector work to an agent granted that connector.',
  },
] as const;

export function PlatformAgentOverview({
  projectId,
  config,
}: {
  projectId: string;
  config: ProjectConfigSummary;
}) {
  const canConfigure =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const goals = useFeatureFlag(projectId, 'goals').enabled;
  const on = config.builtin_agents?.my_kortix ?? true;
  const agents = config.agents.filter((agent) => !agent.platform && !isMetaAgentName(agent.name));

  return (
    <div className="space-y-8">
      <EditorSection title="What it does" lead>
        <SettingRow
          label="Configure your agents"
          help="Creates and narrows agents in kortix.yaml with only the tools, skills, connectors and permissions a task needs. It asks before it widens a grant."
        >
          <State
            on={canConfigure}
            label={canConfigure ? 'Allowed' : 'Needs agent write'}
          />
        </SettingRow>
        <SettingRow
          label="Delegate work"
          help="Starts each task as a durable cloud session of the narrowest agent, waits for it, and reports the verified result."
        >
          <State on label="On" />
        </SettingRow>
        <SettingRow
          label="Run goals"
          help="Owns an objective until it is done: plans it, starts worker and verifier sessions, and checks in every day."
        >
          <State on={goals} label={goals ? 'On' : 'Goals off'} />
        </SettingRow>
        <SettingRow
          label="Build spaces"
          help="Adds and arranges a space's blocks in kortix.yaml through a change request."
        >
          <State on label="On" />
        </SettingRow>
      </EditorSection>

      <EditorSection title="Acts as you">
        <SettingRow
          label="Your permissions, in this project"
          help="Every action runs as the person who started the session. It never holds more than you do."
        >
          <State on label="As you" />
        </SettingRow>
        {NEVER.map((row) => (
          <SettingRow key={row.label} label={row.label} help={row.help}>
            <State on={false} label="No access" />
          </SettingRow>
        ))}
      </EditorSection>

      <EditorSection title="Agents it runs" bare>
        {agents.length > 0 ? (
          <EditorList>
            {agents.map((agent) => (
              <AgentRow key={agent.name} projectId={projectId} agent={agent} />
            ))}
          </EditorList>
        ) : (
          <EmptyState size="sm" title="Agents you create will show up here" />
        )}
      </EditorSection>

      <EditorSection title="In this project">
        <SettingRow
          label="My Kortix"
          help={
            <>
              New sessions start with My Kortix. Kortix maintains its prompt and tools. To turn it
              off, set <span className="font-mono">builtin_agents: {'{ my_kortix: false }'}</span> in
              kortix.yaml.
            </>
          }
        >
          <State on={on} label={on ? 'On' : 'Off'} />
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
        className="hover:bg-hover flex items-center gap-3 px-4 py-3 transition-colors"
      >
        <AgentMark slug={agent.name} />
        <div className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">
            {capitalizeWords(agent.name)}
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
