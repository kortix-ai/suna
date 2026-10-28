'use client';

/**
 * The Overview of My Kortix, the built-in agent (slug `meta`): what it is,
 * how it works in three lines, and a composer that starts a session with it.
 * Nothing here is configurable: Kortix maintains its prompt, tools and model,
 * and the one project switch lives in kortix.yaml (`builtin_agents.my_kortix`).
 * The agents it runs are in the sidebar; what each may use is on its own page.
 *
 * The page mounts only while My Kortix is on: with the switch off, /detail
 * does not list `meta`.
 */

import { ArrowUpIcon } from '@phosphor-icons/react';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { type ReactNode, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Button } from '../../primitives/button';
import { AgentMark } from '../../internal/components/agent-mark';
import { useConfigureThread } from '../use-configure-thread';

/** Literal text (a kortix.yaml key) inside a translated sentence. */
const code = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;

/**
 * Ask My Kortix anything. Sending opens a new session of My Kortix with the
 * request, through the same configure thread every "Ask My Kortix" entry uses.
 */
function Composer({ projectId }: { projectId: string }) {
  const t = useI18nTranslations('agentEditor.tabs');
  const configure = useConfigureThread(projectId);
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim() || configure.pending) return;
    configure.start(text.trim());
  };
  return (
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
      <div className="flex justify-end px-2 pb-2">
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
  );
}

export function PlatformAgentOverview({
  projectId,
}: {
  projectId: string;
  config: ProjectConfigSummary;
}) {
  const t = useI18nTranslations('agentEditor.myKortix');
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const canStart = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SESSION_START).allowed === true;
  const how = [t('capabilities.delegate.help'), t('access.asYou.help'), tTabs('composerNote')];

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
      <AgentMark slug="meta" size={42} />
      <p className="text-foreground text-lg font-medium text-balance">{tTabs('myKortixPromise')}</p>
      <div className="text-muted-foreground space-y-1 text-sm text-pretty">
        {how.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {canStart ? (
        <div className="w-full text-left">
          <Composer projectId={projectId} />
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs text-pretty">{t.rich('project.help', { code })}</p>
    </div>
  );
}
