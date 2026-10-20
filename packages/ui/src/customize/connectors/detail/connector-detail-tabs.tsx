'use client';
import { Button } from '../../../primitives/button';
import { TabsContent } from '../../../primitives/tabs';
import { ErrorState } from '../../../primitives/error-state';
import { useTranslations } from '../../../i18n';
import type { ComponentProps } from 'react';
import { ConnectorAccounts } from './connector-accounts';
import { ConnectorSettings } from './connector-settings';
import { ConnectorTools } from './connector-tools';
import { ConnectorTriggers } from './connector-triggers';
import { useConnectorDetail } from './use-connector-detail';

/** Page and modal share tab content, while retaining their distinct account actions. */
export function ConnectorDetailTabs({
  accounts,
  settings,
  connectionsQuery,
}: {
  accounts: ComponentProps<typeof ConnectorAccounts>;
  settings: ComponentProps<typeof ConnectorSettings>;
  connectionsQuery: ReturnType<typeof useConnectorDetail>['connectionsQuery'];
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { projectId, connector, displayName, canWrite, onChanged } = accounts;
  return (
    <>
      <TabsContent value="accounts">
        {connectionsQuery.isError ? (
          <ErrorState
            size="sm"
            title={tI18nComplete.raw('textbda9de7688c0')}
            description={
              connectionsQuery.error instanceof Error
                ? connectionsQuery.error.message
                : tI18nComplete.raw('textd8eda34a089a')
            }
            action={
              <Button variant="outline" size="sm" onClick={() => void connectionsQuery.refetch()}>
                {tI18nComplete.raw('text942087cc2d41')}
              </Button>
            }
          />
        ) : (
          <ConnectorAccounts {...accounts} />
        )}
      </TabsContent>

      <TabsContent value="tools">
        <ConnectorTools
          projectId={projectId}
          connector={connector}
          displayName={displayName}
          canWrite={canWrite}
          onChanged={onChanged}
        />
      </TabsContent>

      <TabsContent value="triggers">
        <ConnectorTriggers projectId={projectId} connector={connector} displayName={displayName} />
      </TabsContent>

      <TabsContent value="settings">
        <ConnectorSettings {...settings} />
      </TabsContent>
    </>
  );
}
