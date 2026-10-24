'use client';

/**
 * The Overview of My Kortix, the built-in agent (slug `meta`).
 *
 * My Kortix is the one agent a person talks to. It runs the platform and
 * every other agent for them, with their own permissions in this project, and
 * the other agents are its work products. So the page leads with a composer:
 * ask My Kortix to create an agent or change what one may do, and every change
 * opens as a change request. Then the agents it runs, each with its access,
 * then what it can do. The aside says what it can reach and why there are no
 * instructions to edit. Nothing here is configurable: Kortix maintains its
 * prompt, tools and model, and the one project switch lives in kortix.yaml
 * (`builtin_agents.my_kortix`).
 *
 * The page mounts only while My Kortix is on: with the switch off, /detail
 * does not list `meta`. Every capability state reads the viewer's own grants.
 */

import { ArrowUpIcon, CaretRightIcon, PlusIcon } from '@phosphor-icons/react';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';
import { isMetaAgentName } from '@kortix/shared';
import { type ReactNode, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { agentHref, capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { StatusDot } from '../../primitives/status';
import { UiLink as Link } from '../../providers/ui-provider';
import { useConfigureThread } from '../use-configure-thread';
import { AgentAccessText } from './agent-access-text';

type Agent = ProjectConfigSummary['agents'][number];

/** A row's state: a dot that carries the hue and a word that stays ink. */
function State({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <StatusDot tone={on ? 'success' : 'neutral'} />
      <span className={on ? 'text-foreground text-sm' : 'text-muted-foreground text-sm'}>{label}</span>
    </span>
  );
}

/** Literal text (a grant, a kortix.yaml key) inside a translated sentence. */
const code = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;

const NEVER = ['otherProjects', 'tokens', 'secrets', 'connectors'] as const;

/** One divided row: label and help left, state right. */
function Row({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">{label}</p>
        {help ? <p className="text-muted-foreground text-xs text-pretty">{help}</p> : null}
      </div>
      {children}
    </li>
  );
}

function Heading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-foreground text-sm font-medium">{children}</h2>
      {action}
    </div>
  );
}

/**
 * Ask My Kortix to create an agent or change one. Sending opens a new session
 * of My Kortix with the request, through the same configure thread every
 * "Ask My Kortix" entry uses.
 */
function Composer({ projectId }: { projectId: string }) {
  const t = useI18nTranslations('agentEditor.tabs');
  const configure = useConfigureThread(projectId);
  const [text, setText] = useState('');
  const chips = [t('chipCreate'), t('chipNarrow'), t('chipReview')];
  const send = () => {
    if (!text.trim() || configure.pending) return;
    configure.start(text.trim());
  };
  return (
    <section className="space-y-2">
      <div className="bg-background focus-within:border-foreground/30 rounded-md border transition-colors">
        <textarea
          aria-label={t('composerLabel')}
          value={text}
          rows={2}
          placeholder={t('composerPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
          className="text-foreground placeholder:text-muted-foreground block w-full resize-none bg-transparent px-4 pt-3 text-sm outline-none"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {chips.map((chip) => (
              <Button key={chip} variant="outline" size="xs" onClick={() => setText(chip)}>
                {chip}
              </Button>
            ))}
          </div>
          <Button
            size="icon-sm"
            aria-label={t('send')}
            disabled={!text.trim() || configure.pending}
            aria-busy={configure.pending || undefined}
            onClick={send}
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t('composerNote')}</p>
    </section>
  );
}

export function PlatformAgentOverview({
  projectId,
  config,
}: {
  projectId: string;
  config: ProjectConfigSummary;
}) {
  const t = useI18nTranslations('agentEditor.myKortix');
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const canConfigure = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const canDelegate = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SESSION_START).allowed === true;
  const canBuildSpaces = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_GITOPS_MERGE).allowed === true;
  const goals = useFeatureFlag(projectId, 'goals').enabled;
  const agents = config.agents.filter((agent) => !agent.platform && !isMetaAgentName(agent.name));

  const allowed = (on: boolean) => <State on={on} label={on ? t('allowed') : t('notAllowed')} />;
  const denied = (grant: string) => t.rich('denied', { grant, code });

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-8">
        <p className="text-foreground max-w-3xl text-base text-pretty">{tTabs('myKortixPromise')}</p>
        {canDelegate ? <Composer projectId={projectId} /> : null}

        <section className="space-y-3">
          <Heading
            action={
              canConfigure ? (
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <Link href={`${capabilityTabHref(projectId, 'agent')}?new=1`}>
                    <PlusIcon className="size-4" />
                    {tTabs('newAgent')}
                  </Link>
                </Button>
              ) : undefined
            }
          >
            {t('agents.title')}{' '}
            <span className="text-muted-foreground font-normal tabular-nums">{agents.length}</span>
          </Heading>
          {agents.length > 0 ? (
            <ul className="bg-background divide-border divide-y overflow-hidden rounded-md border">
              {agents.map((agent) => (
                <AgentRow key={agent.name} projectId={projectId} agent={agent} />
              ))}
            </ul>
          ) : (
            <EmptyState size="sm" title={t('agents.empty')} />
          )}
        </section>

        <section className="space-y-3">
          <Heading>{t('capabilities.title')}</Heading>
          <ul className="bg-background divide-border divide-y overflow-hidden rounded-md border">
            <Row
              label={t('capabilities.configure.label')}
              help={canConfigure ? t('capabilities.configure.help') : denied('project.agent.write')}
            >
              {allowed(canConfigure)}
            </Row>
            <Row
              label={t('capabilities.delegate.label')}
              help={canDelegate ? t('capabilities.delegate.help') : denied('project.session.start')}
            >
              {allowed(canDelegate)}
            </Row>
            <Row label={t('capabilities.goals.label')} help={t('capabilities.goals.help')}>
              <State on={goals} label={goals ? t('on') : t('goalsOff')} />
            </Row>
            <Row
              label={t('capabilities.spaces.label')}
              help={canBuildSpaces ? t('capabilities.spaces.help') : denied('project.gitops.merge')}
            >
              {allowed(canBuildSpaces)}
            </Row>
          </ul>
        </section>
      </div>

      <div className="min-w-0 space-y-6">
        <section className="space-y-3">
          <Heading>{t('access.title')}</Heading>
          <ul className="bg-background divide-border divide-y overflow-hidden rounded-md border">
            <Row label={t('access.asYou.label')} help={t('access.asYou.help')}>
              <State on label={t('asYou')} />
            </Row>
            {NEVER.map((row) => (
              <Row key={row} label={t(`access.${row}.label`)} help={t(`access.${row}.help`)}>
                <State on={false} label={t('noAccess')} />
              </Row>
            ))}
          </ul>
        </section>
        <section className="space-y-3">
          <Heading>{t('project.title')}</Heading>
          <ul className="bg-background divide-border divide-y overflow-hidden rounded-md border">
            <Row label={t('project.label')} help={t.rich('project.help', { code })}>
              <State on label={t('on')} />
            </Row>
          </ul>
        </section>
        <p className="text-muted-foreground px-1 text-xs text-pretty">{tTabs('myKortixNoInstructions')}</p>
      </div>
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
        <AgentMark slug={agent.name} size={21} />
        <div className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">{agentDisplayName(agent.name)}</span>
          {agent.description ? (
            <span className="text-muted-foreground block truncate text-xs">{agent.description}</span>
          ) : null}
        </div>
        <span className="text-muted-foreground hidden shrink-0 text-sm sm:block">
          <AgentAccessText agent={agent} />
        </span>
        <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      </Link>
    </li>
  );
}
