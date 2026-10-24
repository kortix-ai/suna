'use client';

import type { ProjectConfigSummary } from '@kortix/sdk';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { agentAccess } from './agent-access';

/**
 * What an agent's configuration grants, in one line (KRTX-3025): "Full
 * access", or "2 connectors · 1 secret". A part with nothing granted is left
 * out; an agent with nothing at all reads "No access".
 */
export function AgentAccessText({ agent }: { agent: ProjectConfigSummary['agents'][number] }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const t = useI18nTranslations('agentEditor.tabs');
  const access = agentAccess(agent.scope);
  if (!access) return null;
  if (access.kind === 'full') return <>{tI18nComplete.raw('textf19611c61ca5')}</>;
  const parts = access.parts
    .filter((part) => part.value !== 0)
    .map((part) =>
      part.value === 'all' ? t(`accessAll.${part.kind}`) : t(`accessCount.${part.kind}`, { count: part.value }),
    );
  if (parts.length === 0) return <>{t('noAccess')}</>;
  return <span className="tabular-nums">{parts.join(' · ')}</span>;
}
