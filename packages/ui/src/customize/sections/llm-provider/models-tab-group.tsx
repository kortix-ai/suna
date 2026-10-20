'use client';

import Hint from '../../../primitives/hint';
import { Switch } from '../../../primitives/switch';
import { errorToast } from '../../../primitives/toast';
import { ProviderLogoStatus } from '../../providers/provider-connect';
import { useTranslations } from '../../../i18n';
import {
  useModelAccess,
} from '@kortix/sdk/react';
import { ModelsTabRow, type ModelContext } from './models-tab-row';

import type { ModelGroup } from './model-rows';

export function ModelsTabGroup({
  group, access, enablement, defaults, pickerCatalog, canWrite, holdsDataClaim, platformFee,
}: ModelContext & { group: ModelGroup; platformFee: number | undefined }) {
  const tAccess = useTranslations('modelAccess');
  const tList = useTranslations('modelsList');
  const providerDisabled =
    access.data?.disabledProviders.includes(group.providerID) ?? false;
  const groupOn = group.rows.filter(({ model }) => model.enabled).length;
  const dataClaim =
    group.providerID === 'kortix' &&
    group.rows.every(({ model }) => holdsDataClaim(model.modelID));
  return (
    <section
      key={group.providerID}
      data-provider-group={group.providerID}
      className="bg-popover overflow-hidden rounded-lg border"
    >
      <header className="border-border flex items-center gap-3 border-b px-4 py-3">
        <ProviderLogoStatus
          providerId={group.providerID}
          label={group.providerName}
          status={
            providerDisabled
              ? 'none'
              : group.providerID === 'kortix'
                ? 'included'
                : 'connected'
          }
          size="medium"
        />
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-medium">
            {group.providerName}
          </p>
          {/* One quiet line, not a green panel: both facts are
              reassurance, and the detail lives one hover away.
              `tabIndex` keeps each hint reachable by keyboard. */}
          {group.providerID === 'kortix' && platformFee !== undefined ? (
            <p className="text-muted-foreground text-xs">
              {tList('platformFee', { fee: platformFee })}
            </p>
          ) : null}
          {dataClaim ? (
            <p className="text-muted-foreground text-xs">
              <Hint label={tAccess('zdrDescription')} side="top" className="max-w-xs">
                <span tabIndex={0} className="cursor-help">
                  {tAccess('zdrTitle')}
                </span>
              </Hint>
              {' · '}
              <Hint label={tAccess('usProvidersDescription')} side="top" className="max-w-xs">
                <span tabIndex={0} className="cursor-help">
                  {tAccess('usProvidersTitle')}
                </span>
              </Hint>
            </p>
          ) : null}
        </div>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {tList('onCount', { on: groupOn, total: group.rows.length })}
        </span>
        <ProviderSwitch
          access={access}
          providerId={group.providerID}
          name={group.providerName}
          canWrite={canWrite}
        />
      </header>
      {group.rows.map(({ model, wireId, isRollingAlias }) => (
        <ModelsTabRow
          key={wireId}
          model={model}
          wireId={wireId}
          isRollingAlias={isRollingAlias}
          group={group}
          providerDisabled={providerDisabled}
          access={access}
          enablement={enablement}
          defaults={defaults}
          pickerCatalog={pickerCatalog}
          canWrite={canWrite}
          holdsDataClaim={holdsDataClaim}
        />
      ))}
    </section>
  );
}

/**
 * A whole provider on or off for this project. Credentials stay either way.
 * The project default's provider cannot be turned off until the default moves
 * elsewhere — the same lock the provider sheet's switch applies.
 */
function ProviderSwitch({
  access,
  providerId,
  name,
  canWrite,
}: {
  access: ReturnType<typeof useModelAccess>;
  providerId: string;
  name: string;
  canWrite: boolean;
}) {
  const tAccess = useTranslations('modelAccess');
  if (!access.data?.enforced) return null;
  const enabled = !access.data.disabledProviders.includes(providerId);
  const locked = access.defaultProvider === providerId && enabled;
  return (
    <Hint label={locked ? tAccess('defaultProviderHint') : tAccess('credentialsHint')} side="bottom">
      <span className="inline-flex shrink-0">
        <Switch
          checked={enabled}
          disabled={!canWrite || access.isUpdating || locked}
          aria-label={tAccess('enableProvider', { name })}
          onCheckedChange={(next) =>
            void access
              .setEnabled({ target: 'provider', id: providerId, enabled: next })
              .catch((error: unknown) =>
                errorToast(error instanceof Error ? error.message : tAccess('providerError')),
              )
          }
        />
      </span>
    </Hint>
  );
}
