'use client';

import { listProjectSecrets, setConnectorSecretBinding, type AdminConnector } from '@kortix/sdk';
import { contract, projectSecretsKey } from '@kortix/sdk/react';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

/**
 * Where the connector's server-side credential actually lives — and the
 * two-way door to the Secrets page.
 *
 * The Secrets side has been able to bind a secret to a connector for a while
 * (`secret-delivery.ts`), but the connector side never said so: a connector
 * whose credential IS the project secret `LINEAR_API_KEY` showed the same
 * "credential set" state as one holding a pasted value, and nothing linked
 * back. This row closes the loop: it names the source in words, shows the
 * secret identifier when one is bound, links to the Secrets page, and lets a
 * writer bind or unbind an existing secret right here — the same
 * `secret-binding` API the Secrets page uses, so the two surfaces cannot
 * disagree.
 *
 * Rendered only for connectors that declare a project-owned credential
 * (`authSecret` set, `authorizationStrategy: 'project'`). Managed OAuth
 * connectors, channels, and computer profiles have no pasted credential to
 * source.
 */
export function ConnectorCredentialRow({
  projectId,
  connector,
  canWrite,
  onChanged,
  onReplace,
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  onChanged: () => void;
  /** Opens the Connect form to paste a new value (Settings' "Replace",
   *  Jay's R4 pick). Omit to render the row without it. */
  onReplace?: () => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const source = connector.credentialSource ?? (connector.secretSet ? 'stored' : 'none');
  const boundIdentifier = source === 'project_secret' ? (connector.secretIdentifier ?? null) : null;
  const [confirmUnbind, setConfirmUnbind] = useState(false);

  // The SAME cache entry the Secrets page reads (`projectSecretsKey`), so the
  // list offered here is the list a manager just saw there. Manager-tier read,
  // so it is gated on `canWrite` — a reader gets the statement, no picker.
  //
  // The filter mirrors what the server's `validateConnectorSecretBinding`
  // accepts — a configured shared row delivered by the Kortix service for a
  // connector (`strategy: 'broker'`, `consumer: 'connector'`). Offering
  // anything looser here would put options in the picker that can only 409.
  const secretsQuery = useQuery({
    queryKey: projectSecretsKey(projectId),
    queryFn: () => listProjectSecrets(projectId),
    enabled: canWrite,
    ...contract('config'),
  });
  const bindable = (secretsQuery.data?.items ?? []).filter(
    (row) =>
      row.configured && !row.system && row.strategy === 'broker' && row.consumer === 'connector',
  );

  const bind = useMutation({
    mutationFn: (identifier: string | null) =>
      setConnectorSecretBinding(projectId, connector.slug, identifier),
    onSuccess: (_result, identifier) => {
      successToast(
        identifier
          ? tI18nComplete('textf75561ab0be6', { value0: identifier })
          : tI18nComplete.raw('texteec42a6f22ad'),
      );
      setConfirmUnbind(false);
      onChanged();
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text2ba8a1bcfc5c')),
  });

  // Nothing set AND nothing bindable = nothing to say. The Connect CTA and
  // the stepper above already carry "add a credential"; a row restating it
  // with no control attached is dead weight on an already-empty connector.
  // With `onReplace` the row still has a job: it is the way in.
  const canReplace = Boolean(onReplace) && canWrite && source !== 'platform';
  if (source === 'none' && bindable.length === 0 && !canReplace) return null;

  const statement =
    source === 'project_secret' && boundIdentifier
      ? tI18nComplete('text86f0b18d6d8a', { value0: boundIdentifier })
      : source === 'stored'
        ? // Same rule the Secrets page states from its side: the server refuses a
          // binding while a stored value exists.
          'A value stored with this connector, encrypted. To switch to a project secret, disconnect the stored credential first.'
        : source === 'platform'
          ? 'Managed by Kortix for this deployment.'
          : 'Nothing set. Connect a credential, or bind an existing project secret.';

  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('text221bee24f060')}
            </p>
            <Button
              asChild
              variant="text"
              size="sm"
              className="text-muted-foreground h-auto gap-0.5 px-0 text-xs"
            >
              <Link href={`/projects/${projectId}/secrets`}>
                {tI18nComplete.raw('textd8707d411d99')}
                <ArrowUpRightIcon className="size-3 shrink-0" />
              </Link>
            </Button>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{statement}</p>
        </div>

        {/* No picker while a stored value exists — the server 409s every bind
            in that state, and a control that can only error is worse than the
            sentence above explaining the order of operations. */}
        {canReplace ||
        (canWrite &&
          (source === 'project_secret' || (source === 'none' && bindable.length > 0))) ? (
          <div className="flex shrink-0 items-center gap-2">
            {canReplace ? (
              <Button size="sm" variant="ghost" onClick={onReplace}>
                {source === 'none'
                  ? tI18nComplete.raw('text1a2303ede074')
                  : tI18nComplete.raw('text54483ce856e0')}
              </Button>
            ) : null}
            {canWrite &&
            (source === 'project_secret' || (source === 'none' && bindable.length > 0)) ? (
              <Select
                // Driven by the live binding so a bind/unbind reflects with no
                // local state. `''` (nothing bound) shows the placeholder;
                // "unbind" is a sentinel item, present only while a binding
                // exists to step off of.
                value={boundIdentifier ?? ''}
                onValueChange={(next) => {
                  if (next === (boundIdentifier ?? '')) return;
                  if (next === 'unbind') {
                    setConfirmUnbind(true);
                    return;
                  }
                  bind.mutate(next);
                }}
                disabled={bind.isPending}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56">
                  <SelectValue placeholder={tI18nComplete.raw('textc769b970c58f')} />
                </SelectTrigger>
                <SelectContent>
                  {source === 'project_secret' ? (
                    <SelectItem value="unbind">{tI18nComplete.raw('textda9e74dcdde6')}</SelectItem>
                  ) : null}
                  {bindable.map((row) => (
                    <SelectItem key={row.identifier} value={row.identifier}>
                      {row.identifier}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmUnbind}
        onOpenChange={setConfirmUnbind}
        title={tI18nComplete('text4b29172693be', {
          value0: boundIdentifier ?? tI18nComplete.raw('text650179ec8cbe'),
        })}
        description={tI18nComplete.raw('text618c9623e0f3')}
        confirmLabel={tI18nComplete.raw('textdca68375fa4f')}
        confirmVariant="destructive"
        isPending={bind.isPending}
        onConfirm={() => bind.mutate(null)}
      />
    </div>
  );
}
