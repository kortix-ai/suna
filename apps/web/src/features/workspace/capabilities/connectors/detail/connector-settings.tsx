'use client';

import { useTranslations } from '@/i18n/use-translations';
import { type AdminConnector, deleteConnector, setConnectorName } from '@kortix/sdk';
import { TrashIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { ConnectionSection } from '@/features/workspace/customize/sections/connectors-view';
import { isManagedConnectorProvider } from '../provider-label';
import { connectorRunsOver } from './connector-status';

export interface ConnectorSettingsProps {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  onChanged: () => void;
  onRemoved: () => void;
}

/**
 * Settings — the connector's name, the transport config for a direct
 * provider, then removing the connector.
 *
 * `connectorTabs` already restricts this tab to writers.
 *
 * `ConnectionSection` (slug/provider/spec/auth/headers) used to sit on the
 * Accounts tab, gated on `canWrite` with a reader-only banner in its place.
 * It moved HERE — connector-credentials rework follow-up (the live defect an
 * openapi/http/mcp/graphql connector's Accounts tab rendered this transport
 * form instead of its account list). Accounts now always shows
 * `ConnectionsList` for a direct provider, same as a managed one, so this is
 * the only mount left — showing it on both tabs would print the same form
 * twice (`connector-settings.write-path.test.ts` pins that). A managed
 * (Composio/Pipedream), channel, or computer connector has no transport
 * config to edit, so it is skipped here.
 *
 * The "Connects as" row is gone. `connectors.authorization_strategy` was a
 * connector-level MODE that made shared and private accounts mutually
 * exclusive, and it is the direct cause of the connector-credentials incident:
 * a `user`-mode connector had no connect flow anywhere. Ownership is now a
 * property of each account — see the Accounts tab.
 *
 * The name is edited here, in a field with a Save button. It used to be a
 * pencil beside the title, which made the heading itself an input.
 */
export function ConnectorSettings({
  projectId,
  connector,
  displayName,
  onChanged,
  onRemoved,
}: ConnectorSettingsProps) {
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const isChannel = connector.provider === 'channel';
  const managed = isManagedConnectorProvider(connector.provider);
  const isComputer = connector.provider === 'computer';
  const isDirectProvider =
    !isManagedConnectorProvider(connector.provider) && !isChannel && !isComputer;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => deleteConnector(projectId, connector.slug),
    onSuccess: () => {
      successToast(tI18nComplete('textffd34ade9168', { value0: displayName }));
      onRemoved();
    },
    onError: (e: Error) => errorToast(e.message || tI18nComplete.raw('text1d0486014da5')),
  });

  const nameId = useId();
  // `null` until the user types, so the field follows a rename made elsewhere.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const name = nameDraft ?? displayName;
  const nameChanged = name.trim().length > 0 && name.trim() !== displayName;
  const rename = useMutation({
    mutationFn: () => setConnectorName(projectId, connector.slug, name.trim()),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text05487af3f074'));
      setNameDraft(null);
      onChanged();
    },
    onError: (e: Error) => errorToast(e.message || tI18nComplete.raw('text8fcf8ce07dcf')),
  });

  return (
    <div className="space-y-8">
      <div className="bg-popover divide-y rounded-md border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <Label htmlFor={nameId} className="text-sm font-medium">
              {t('nameLabel')}
            </Label>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{t('nameHelp')}</p>
          </div>
          <form
            className="flex w-56 shrink-0 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (nameChanged) rename.mutate();
            }}
          >
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setNameDraft(event.target.value)}
              variant="popover"
              maxLength={255}
              className="min-w-0 flex-1"
              disabled={rename.isPending}
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="shrink-0 gap-1.5"
              disabled={!nameChanged || rename.isPending}
            >
              {rename.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('text1509f561f241')}
            </Button>
          </form>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">
              {managed ? t('signInLabel') : t('infoRunsOver')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
              {managed
                ? t('signInManagedHelp', { provider: connectorRunsOver(connector.provider) })
                : t('runsOverDirectHelp', { name: displayName })}
            </p>
          </div>
          <Badge variant="outline" size="sm" className="shrink-0">
            {connectorRunsOver(connector.provider)}
          </Badge>
        </div>
      </div>

      {isDirectProvider ? (
        <ConnectionSection
          projectId={projectId}
          connector={connector}
          onChanged={onChanged}
          canWrite={true}
        />
      ) : null}

      {/* Capability #11. Channel connectors disconnect from their own connection
          form (`ChannelConnectionSection`), so they get no Remove row here.
          The row stays neutral — `variant="destructive"` belongs on the confirm
          button inside `ConfirmDialog`, not on the panel. */}
      {!isChannel && !isComputer ? (
        <div className="bg-popover rounded-md border px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">
                {t('removeTitle', { name: displayName })}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                {t('removeHelp')}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5 active:scale-[0.96]"
              onClick={() => setConfirmDelete(true)}
            >
              <TrashIcon className="size-3.5 shrink-0" />
              {tI18nComplete.raw('textc3812fc4acb8')}
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tI18nComplete('textbc43ab815937', { value0: displayName })}
        description={
          <>
            {tI18nComplete.raw('text0c044575853f')}{' '}
            <code className="font-mono">{connector.slug}</code>
            {tI18nComplete.raw('text9627c3d54219')}
          </>
        }
        confirmLabel={tI18nComplete.raw('textbf30cc3b0697')}
        confirmVariant="destructive"
        confirmIcon={<TrashIcon className="size-4 shrink-0" />}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
