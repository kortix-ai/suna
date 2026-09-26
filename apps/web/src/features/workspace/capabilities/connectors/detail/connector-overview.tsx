'use client';

import { getConnectorConfig, getConnectorPolicies, type AdminConnector } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { CopyButton } from '@/components/markdown/copy-button';
import { Label } from '@/components/ui/label';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { connectorKindLabel } from '../provider-label';
import { connectorMcpUrl } from './connector-mcp-url';
import { policyCountsFromEffective } from './connector-status-strip';
import { connectorTryPrompts } from './connector-try-prompts';

export type ConnectorOverviewState = 'connected' | 'setup' | 'failing';

/**
 * Overview — the connector at a glance, in EVERY state (Jay, 2026-09-26).
 *
 * One facts card in the Settings dialect (label left, value right, hairline
 * between): status, who it connects as, what its tools will do, and what
 * kind of connector it is. Under it, whatever the state asks for next —
 * the setup steps until connected, prompts to try once it is. The facts
 * never claim more than the state: a connector that is not connected says
 * "Needs setup", never "Active".
 *
 * No "Recent activity": no API serves per-connector call history today.
 */
export function ConnectorOverview({
  projectId,
  connector,
  canWrite,
  usesProjectAuthorization,
  state,
  setup,
  onTryPrompt,
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  usesProjectAuthorization: boolean;
  state: ConnectorOverviewState;
  /** The setup steps, rendered under the facts while not connected. */
  setup?: ReactNode;
  /** Starts a session with this connector and the prompt already sent. */
  onTryPrompt: (text: string) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');

  // The Tools tab's own query key — one cache entry for both tabs. Reading
  // policies is admin-gated, so a reader gets the read/write split instead.
  const policiesQuery = useQuery({
    queryKey: ['connector-policies', projectId, connector.slug],
    queryFn: () => getConnectorPolicies(projectId, connector.slug),
    staleTime: 5_000,
    enabled: canWrite,
  });
  const policyCounts = policyCountsFromEffective(policiesQuery.data?.effective);
  // KRTX-203: an MCP connector's server URL, visible and copyable. Writers
  // only — the config route is gated on `project.connector.write`, and some
  // hosted MCP servers embed an access token in the URL path. Shares the
  // Settings / Accounts config query key, so it costs no extra request.
  const isMcp = connector.provider === 'mcp';
  const configQuery = useQuery({
    queryKey: qk.project.connectorConfig(projectId, connector.slug),
    queryFn: () => getConnectorConfig(projectId, connector.slug),
    ...contract('config'),
    enabled: canWrite && isMcp,
  });
  const mcpUrl = isMcp ? connectorMcpUrl(connector, configQuery.data) : null;
  const prompts = useMemo(() => connectorTryPrompts(connector.actions), [connector.actions]);

  const toolCount = connector.actions.length;
  const readCount = connector.actions.filter((action) => action.risk === 'read').length;
  const toolTitle =
    toolCount === 1
      ? tI18nComplete('text10ee6de02d68', { value0: toolCount })
      : tI18nComplete('texta2c9c9bb546d', { value0: toolCount });
  const toolDetail = policyCounts
    ? tI18nComplete('textb3421ce71d7d', {
        value0: policyCounts.allowed,
        value1: policyCounts.ask,
        value2: policyCounts.blocked,
      })
    : tI18nComplete('text29012a17f0f7', { value0: readCount, value1: toolCount - readCount });

  const facts: { label: string; value: ReactNode; detail?: string }[] = [
    {
      label: tI18nComplete.raw('text920e413c7d41'),
      value: (
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              'size-2 shrink-0 rounded-full',
              state === 'connected'
                ? 'bg-kortix-green'
                : state === 'failing'
                  ? 'bg-kortix-red'
                  : 'bg-kortix-orange',
            )}
          />
          {state === 'connected'
            ? tI18nComplete.raw('text92340695899b')
            : state === 'failing'
              ? tI18nComplete.raw('textfebd25f4b5c2')
              : tI18nComplete.raw('textb6df2441064f')}
        </span>
      ),
    },
    {
      label: tI18nComplete.raw('textfa065317dfc5'),
      value: usesProjectAuthorization
        ? tI18nComplete.raw('text28ff734e9722')
        : tI18nComplete.raw('textbdd6bef05a78'),
      detail: usesProjectAuthorization
        ? tI18nComplete.raw('textdd61b09ef592')
        : tI18nComplete.raw('text5219e991ae74'),
    },
    ...(toolCount > 0
      ? [{ label: tI18nComplete.raw('textea93d6a262ec'), value: toolTitle, detail: toolDetail }]
      : []),
    {
      label: tI18nComplete.raw('textbaaddf70fb5d'),
      value: connectorKindLabel(connector.provider),
    },
    ...(mcpUrl
      ? [
          {
            label: tI18nComplete.raw('textefbec00903d5'),
            value: (
              <span className="flex min-w-0 items-center gap-1.5" data-testid="connector-mcp-url">
                <code className="min-w-0 truncate font-mono text-xs font-normal" title={mcpUrl}>
                  {mcpUrl}
                </code>
                <CopyButton code={mcpUrl} size="sm" hintSide="bottom" />
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <dl className="bg-popover divide-y rounded-md border">
        {facts.map((fact) => (
          <div key={fact.label} className="flex items-start gap-4 px-4 py-3">
            <dt className="text-muted-foreground w-28 shrink-0 text-sm">{fact.label}</dt>
            <dd className="min-w-0 flex-1">
              <div className="text-foreground text-sm font-medium">{fact.value}</div>
              {fact.detail ? (
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{fact.detail}</p>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      {state === 'connected' ? null : setup}

      {state === 'connected' && prompts.length > 0 ? (
        <section className="space-y-2">
          <Label>{tI18nComplete.raw('textcf944f8de20e')}</Label>
          <ul className="bg-popover divide-y overflow-hidden rounded-md border">
            {prompts.map((prompt) => (
              <li key={prompt.path}>
                <button
                  type="button"
                  onClick={() => onTryPrompt(prompt.text)}
                  className="group hover:bg-hover focus-visible:ring-ring flex w-full items-center gap-2.5 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                    “{prompt.text}”
                  </span>
                  <CaretRightIcon className="text-muted-foreground group-hover:text-foreground size-3.5 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
