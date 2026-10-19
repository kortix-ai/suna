'use client';

import { listConnectorMoves } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { UiLink as Link } from '@kortix/ui/providers/ui-provider';
import { Fragment } from 'react';

import { InfoBanner } from '@/components/ui/info-banner';
import { useTranslations } from '@/i18n/use-translations';

import { connectorHref } from './connector-routes';
import { connectorMovesQueryKey } from './detail/connector-move-row';

/** The Pipedream connectors a `connectors_v2` project can move to Kortix apps, each linked to its page. */
export function ConnectorMovesBanner({ projectId }: { projectId: string }) {
  const t = useTranslations('connectorPages');
  const enabled = useFeatureFlag(projectId, 'connectors_v2').enabled;
  const moves = useQuery({
    queryKey: connectorMovesQueryKey(projectId),
    queryFn: () => listConnectorMoves(projectId),
    enabled,
  });
  const movable = (moves.data ?? []).filter((move) => move.to);
  if (!enabled || movable.length === 0) return null;
  return (
    <InfoBanner tone="info" title={t('movesBannerTitle', { count: movable.length })}>
      <p className="text-muted-foreground text-xs text-pretty">
        {t('movesBannerBody')}{' '}
        {movable.map((move, index) => (
          <Fragment key={move.slug}>
            {index > 0 ? ', ' : null}
            <Link
              href={connectorHref(projectId, move.slug)}
              className="text-foreground underline-offset-2 hover:underline"
            >
              {move.name}
            </Link>
          </Fragment>
        ))}
      </p>
    </InfoBanner>
  );
}
