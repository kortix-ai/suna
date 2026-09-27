'use client';

/**
 * "What this agent can do" — the agent's authority as the platform computes it
 * (spec `docs/specs/2026-09-22-agents-as-principals.md` §2.1):
 *
 *   Kortix permissions (kortix.yaml) ∩ ceiling role (IAM) − human-only
 *
 * This is how Kortix works, not a mode the project chose, so the card states
 * it flatly and never mentions a feature flag. The one remaining off-switch
 * (`agent_principal`, spec §5) is a support lever for a single migrating
 * project and is deleted next release — a project that used it sees a card
 * that overstates the agent's independence for that one release, which is the
 * accepted cost of not advertising the switch.
 *
 * Read-only. The Kortix permissions are edited on the same tab (the checklist
 * above this card, which writes kortix.yaml); the ceiling is an IAM role an
 * admin binds to the agent in the Access hub.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { hubTarget } from '@/stores/account-panel-store';
import { HubLink } from '@/features/accounts/hub/account-hub-location';
import {
  EditorSection,
  SettingBlock,
  SettingRow,
} from '@/features/workspace/customize/sections/view/agent-editor-primitives';
import {
  useAgentAuthority,
  type PermissionGrant,
} from '@/features/workspace/shared/access/agent-principals';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

export function AgentAuthorityCard({
  projectId,
  agentName,
  grant,
}: {
  projectId: string;
  agentName: string;
  /** The agent's `kortix_permissions` — the live draft on the editor, the
   *  committed manifest on the read-only page. */
  grant: PermissionGrant;
}) {
  const t = useI18nTranslations('agentPrincipals');
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const accountId = detailQuery.data?.project?.account_id;
  const state = useAgentAuthority({ projectId, accountId, agentName, grant });
  const { authority, ceiling } = state;

  const declaredLabel =
    grant === 'all'
      ? t('declaredAll')
      : authority.declared.length === 0
        ? t('declaredNone')
        : t('declaredCount', { count: authority.declared.length });

  return (
    <div data-testid="agent-authority">
      <EditorSection
        title={t('title')}
        description={t('description')}
        trailing={
          <Badge variant="outline" size="sm" className="tabular-nums">
            {t('effectiveCount', { count: authority.effective.length })}
          </Badge>
        }
      >
        <SettingRow label={t('kortixPermissions')} help={t('kortixPermissionsHelp', { agent: agentName })}>
          <span className="text-foreground block text-sm sm:text-right">{declaredLabel}</span>
        </SettingRow>

        <SettingRow label={t('ceiling')} help={t('ceilingHelp')}>
          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end" data-testid="agent-ceiling">
            {ceiling.kind === 'loading' ? (
              <Skeleton className="h-5 w-32" />
            ) : ceiling.kind === 'hidden' ? (
              <span className="text-muted-foreground text-sm">{t('ceilingHidden')}</span>
            ) : ceiling.kind === 'default' ? (
              <span className="text-foreground text-sm">{t('ceilingDefault')}</span>
            ) : (
              ceiling.roleKeys.map((key) => (
                <Badge key={key} variant="outline" size="sm" className="capitalize">
                  {key}
                </Badge>
              ))
            )}
            {accountId && ceiling.kind !== 'hidden' && ceiling.kind !== 'loading' ? (
              <Button asChild variant="ghost" size="sm" className="gap-1 px-2">
                <HubLink to={hubTarget(accountId, { tab: 'access-projects', project: projectId })}>
                  {t('changeCeiling')}
                  <ArrowUpRightIcon className="size-3.5 shrink-0" />
                </HubLink>
              </Button>
            ) : null}
          </div>
        </SettingRow>

        <SettingRow label={t('humanOnly')} help={t('humanOnlyHelp')}>
          <span className="text-foreground block text-sm sm:text-right">{t('humanOnlyValue')}</span>
        </SettingRow>

        <SettingBlock label={t('effective')} help={t('effectiveHelp')}>
          <ul className="flex flex-wrap gap-1" data-testid="agent-effective-permissions">
            {authority.effective.map((permission) => (
              <li key={permission}>
                <Badge variant="outline" size="xs" className="font-mono">
                  {permission}
                </Badge>
              </li>
            ))}
          </ul>
          {authority.outsideCeiling.length > 0 ? (
            <DroppedList
              label={t('outsideCeiling')}
              permissions={authority.outsideCeiling}
              testId="agent-outside-ceiling"
            />
          ) : null}
          {authority.humanOnly.length > 0 ? (
            <DroppedList
              label={t('droppedHumanOnly')}
              permissions={authority.humanOnly}
              testId="agent-dropped-human-only"
            />
          ) : null}
        </SettingBlock>
      </EditorSection>
    </div>
  );
}

function DroppedList({
  label,
  permissions,
  testId,
}: {
  label: string;
  permissions: string[];
  testId: string;
}) {
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <p className="text-muted-foreground text-xs">{label}</p>
      <ul className="flex flex-wrap gap-1">
        {permissions.map((permission) => (
          <li key={permission}>
            <Badge variant="muted" size="xs" className="font-mono line-through">
              {permission}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

