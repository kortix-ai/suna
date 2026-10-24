'use client';

import type { AgentGrantSetV2, ProjectConfigSummary } from '@kortix/sdk';
import { KeyIcon, PlugsConnectedIcon, TerminalWindowIcon } from '@phosphor-icons/react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { agentAccess } from './agent-access';

/**
 * The one way Customize names a grant, on every surface (the Access switcher,
 * the Overview rows, the Agents index, My Kortix): "All", "None", "N of M"
 * when the catalog size is known, else "N".
 */
export function useGrantLabel(): (value: AgentGrantSetV2 | number | undefined, total?: number) => string {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  return (value, total) => {
    if (value === 'all') return tPage('all');
    const count = typeof value === 'number' ? value : Array.isArray(value) ? value.length : 0;
    if (count === 0) return tPage('none');
    return total !== undefined ? t('countOf', { count, total }) : String(count);
  };
}

const KIND_ICON = { connectors: PlugsConnectedIcon, secrets: KeyIcon, actions: TerminalWindowIcon } as const;

/**
 * What an agent's configuration grants (KRTX-3025), in the agent page's words
 * and glyphs: connectors, secrets and Kortix permissions, each All, None or a
 * count. Every part shows, in the same order, so rows line up in a list. The
 * glyph is the Overview row's glyph; its name is the accessible label.
 */
export function AgentAccessText({ agent }: { agent: ProjectConfigSummary['agents'][number] }) {
  const t = useI18nTranslations('agentEditor.tabs');
  const label = useGrantLabel();
  const access = agentAccess(agent.scope);
  if (!access) return null;
  const parts =
    access.kind === 'full'
      ? (['connectors', 'secrets', 'actions'] as const).map((kind) => ({ kind, value: 'all' as const }))
      : access.parts;
  const kindLabel = {
    connectors: t('accessKindConnectors'),
    secrets: t('accessKindSecrets'),
    actions: t('accessKindActions'),
  };
  return (
    <span className="inline-flex min-w-0 items-center gap-3 tabular-nums">
      {parts.map((part) => {
        const Glyph = KIND_ICON[part.kind];
        const value = label(part.value);
        return (
          <span
            key={part.kind}
            title={`${kindLabel[part.kind]}: ${value}`}
            className={
              part.value === 0 ? 'text-muted-foreground flex items-center gap-1' : 'text-foreground flex items-center gap-1'
            }
          >
            <Glyph aria-hidden className="size-3.5 shrink-0" />
            <span className="sr-only">{kindLabel[part.kind]}</span>
            <span>{value}</span>
          </span>
        );
      })}
    </span>
  );
}
