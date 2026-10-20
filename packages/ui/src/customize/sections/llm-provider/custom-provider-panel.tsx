'use client';

import { useTranslations } from '../../../i18n';
/**
 * `CustomProviderPanel` — the Custom tab's whole body.
 *
 * ## Why this is a tab and not a section
 *
 * It used to be section 4 of the API-keys screen, behind an "Add a custom
 * provider" button. That put a job almost nobody does — pointing Kortix at a
 * self-hosted or unlisted OpenAI-compatible endpoint — at the bottom of the
 * screen EVERYBODY uses to paste an Anthropic key, where it was one more
 * heading to read past on the way to nothing.
 *
 * A tab costs the people who need it one click and costs everyone else
 * nothing, which is the trade a tab exists to make.
 *
 * ## Why it is a LIST, not a lone form
 *
 * The tab used to be one thing: a bordered card of six fields floating in an
 * otherwise empty pane, with no connection to the API-keys list one tab over
 * and no evidence that a custom provider you added last week exists at all.
 * Two problems, one fix — the same shape `provider-connect.tsx` uses:
 *
 *  1. *It read as a different product.* Same job (give this project a
 *     credential for a model endpoint), completely different screen. Now it is
 *     the same flat two-column row — identity left, value right, one axis down
 *     the page — so the two tabs are visibly one surface.
 *  2. *Nothing ever showed what you had already added.* A custom provider
 *     leaves exactly one trace on the server: the project secret
 *     `CUSTOM_<ID>_API_KEY` the form writes (see `custom-provider-form.tsx`).
 *     That is enough to list them, so the tab now opens on what this project
 *     already has, with the form under it.
 *
 * There is deliberately no Remove control on those rows. Deleting the secret
 * would NOT remove the provider — the provider itself lives in the repo's
 * provider configuration, which this app does not own — so a button
 * promising removal here would be lying about what it did.
 *
 * The form IS the tab (Paper board CP01: the form beside a live snippet).
 * When the project already has custom providers they list above it (board
 * CP02), and a row opens that provider in the Models page's side sheet
 * (`useModelsPageSheet`): the secret it uses, where it is declared, and a
 * Replace key control. `onDone` still returns the
 * reader to the Providers tab, because "done" means the provider now has a key
 * like any other and the list is where it shows up.
 */

import { type FormEvent, useState } from 'react';

import { Button } from '../../../primitives/button';
import { InputGroup, InputGroupInput } from '../../../primitives/input-group';
import Loading from '../../../primitives/loading';
import { Skeleton } from '../../../primitives/skeleton';
import {
  SplitSheetBody,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetTitle,
} from '../../../primitives/split-sheet';
import { errorToast, successToast } from '../../../primitives/toast';
import { ProviderLogoStatus } from '../../providers/provider-connect';
import { cn } from '../../../internal/lib/utils';
import { listProjectSecrets, upsertProjectSecret } from '@kortix/sdk';
import { contract, qk, refreshProjectProviderState } from '@kortix/sdk/react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useModelsPageSheet } from '../models-page-sheet';
import { CustomProviderForm, customProviderSecretName } from './custom-provider-form';

/** The one secret name shape `CustomProviderForm` writes. */
const CUSTOM_SECRET_PATTERN = /^CUSTOM_(.+)_API_KEY$/;

/** The file a custom provider is declared in. This app does not own it. */
const DECLARED_IN = 'provider configuration';

/**
 * Provider ids that already have a key on this project, recovered from the
 * secret names. Exported for the test that pins the round trip against the
 * name the form builds.
 */
export function customProviderIdsFromSecrets(names: string[]): string[] {
  const ids = new Set<string>();
  for (const name of names) {
    const match = CUSTOM_SECRET_PATTERN.exec(name);
    if (match?.[1]) ids.add(match[1].toLowerCase().replace(/_/g, '-'));
  }
  return [...ids].sort();
}

/** One added custom provider: a row that opens it in the sheet. */
export function CustomProviderRow({
  id,
  selected,
  onSelect,
}: {
  id: string;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <button
      type="button"
      data-custom-provider-row={id}
      aria-current={selected || undefined}
      onClick={() => onSelect(id)}
      className={cn(
        'group flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2 text-left',
        'hover:bg-muted/60 transition-[background-color] duration-(--duration-normal) ease-out',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        selected && 'bg-muted hover:bg-muted',
      )}
    >
      <ProviderLogoStatus providerId={id} label={id} status="connected" size="medium" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{id}</span>
        <span className="text-muted-foreground block truncate font-mono text-xs">
          {tI18nComplete.raw('textcef709637aa5')} {DECLARED_IN}
        </span>
      </span>
      <CaretRightIcon
        className={cn(
          'text-muted-foreground size-3.5 shrink-0 transition-[color] duration-(--duration-normal)',
          'group-hover:text-foreground',
          selected && 'text-foreground',
        )}
      />
    </button>
  );
}

/** One label/value line in the provider detail. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 py-2">
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      <code className="text-foreground min-w-0 truncate font-mono text-xs">{value}</code>
    </div>
  );
}

/**
 * One saved custom provider. All the app knows about it is the secret name;
 * the base URL and the models live in the repo file, so the sheet says where
 * and offers what it CAN do: replace the key. There is no Remove — deleting
 * the secret would not remove the provider.
 */
function CustomProviderDetail({ projectId, id }: { projectId: string; id: string }) {
  const t = useTranslations('customProvider');
  const tSheet = useTranslations('providerSheet');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const secretName = customProviderSecretName(id);
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState('');

  const replace = useMutation({
    mutationFn: () =>
      upsertProjectSecret(projectId, {
        name: secretName,
        value: value.trim(),
        strategy: 'broker',
        consumer: 'llm_gateway',
      }),
    onSuccess: () => {
      successToast(t('keyReplaced'));
      setValue('');
      setReplacing(false);
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : tI18nComplete.raw('text2c07997249ab')),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() && !replace.isPending) replace.mutate();
  };

  return (
    <>
      <SplitSheetHeader closeLabel={tSheet('close')} className="px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogoStatus providerId={id} label={id} status="connected" size="large" />
          <div className="min-w-0 space-y-0.5">
            <SplitSheetTitle className="truncate text-base font-semibold">{id}</SplitSheetTitle>
            <SplitSheetDescription className="font-mono">{id}</SplitSheetDescription>
          </div>
        </div>
      </SplitSheetHeader>
      <SplitSheetBody className="space-y-6">
        <section className="space-y-1">
          <h3 className="text-foreground text-sm font-medium">{t('endpoint')}</h3>
          <div className="divide-border divide-y">
            <DetailRow label={tI18nComplete.raw('text16f0ee47f993')} value={secretName} />
            <DetailRow label={t('declaredIn')} value={DECLARED_IN} />
          </div>
        </section>

        {replacing ? (
          <form onSubmit={submit} className="space-y-3" data-custom-provider-replace="">
            <label htmlFor={`custom-replace-${id}`} className="sr-only">
              {tI18nComplete.raw('text16f0ee47f993')}
            </label>
            <InputGroup>
              <InputGroupInput
                id={`custom-replace-${id}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                data-1p-ignore=""
                data-lpignore="true"
                data-form-type="other"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={tI18nComplete.raw('textb009c6c5299f')}
                className="font-mono"
              />
            </InputGroup>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!value.trim() || replace.isPending} className="gap-1.5">
                {replace.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                {tSheet('saveKey')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={replace.isPending}
                onClick={() => {
                  setValue('');
                  setReplacing(false);
                }}
              >
                {tSheet('cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={() => setReplacing(true)}>
            {tSheet('replace')}
          </Button>
        )}

        <p className="text-muted-foreground text-xs text-pretty">
          {t('repoNote', { file: DECLARED_IN })}
        </p>
      </SplitSheetBody>
      <SplitSheetFooter className="justify-end">
        <span className="text-muted-foreground text-xs">{tSheet('storedEncrypted')}</span>
      </SplitSheetFooter>
    </>
  );
}

export function CustomProviderPanel({
  projectId,
  canWrite = false,
  onDone,
}: {
  projectId: string;
  canWrite?: boolean;
  /** Called on a successful save — hosts send the reader back to the Providers
   *  list, where the new provider now has a row. */
  onDone?: () => void;
}) {
  const t = useTranslations('customProvider');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [openId, setOpenId] = useState<string | null>(null);
  // A saved provider opens in the Models page's one side sheet, beside the
  // whole page — not a second sheet inside this tab's column.
  const renderSheet = useModelsPageSheet(openId !== null, () => setOpenId(null));
  // Same query key the Providers tab already fills, so this is a cache read in
  // every path that matters — no extra round trip for a list this small.
  const secrets = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
    enabled: canWrite,
  });

  if (!canWrite) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-foreground text-sm">{tI18nComplete.raw('textb4214ac48923')}</p>
        <p className="text-muted-foreground max-w-xs text-xs text-pretty">
          {tI18nComplete.raw('text09f1d00ed790')}
        </p>
      </div>
    );
  }

  const data = secrets.data;
  const items = Array.isArray(data) ? data : (data?.items ?? []);
  const ids = customProviderIdsFromSecrets(items.map((item) => item.name));

  return (
    // `pt-2.5` + the shell's `space-y-5` = board CP01's 28px from the tab row.
    <div className="flex flex-col gap-8 pt-2.5">
      {/* Paper board CP02: what this project already has, above the form.
          Only when there is something to show — the form is the tab. */}
      {secrets.isPending ? (
        <Skeleton className="h-12 rounded-md" />
      ) : ids.length > 0 ? (
        <section className="flex flex-col gap-0.5" aria-label={t('group', { count: ids.length })}>
          <h3 className="text-muted-foreground px-3 pb-1 text-xs font-medium tabular-nums">
            {t('group', { count: ids.length })}
          </h3>
          {ids.map((id) => (
            <CustomProviderRow key={id} id={id} selected={openId === id} onSelect={setOpenId} />
          ))}
        </section>
      ) : null}

      <CustomProviderForm projectId={projectId} onDone={() => onDone?.()} />

      {renderSheet(
        openId ? <CustomProviderDetail key={openId} projectId={projectId} id={openId} /> : null,
      )}
    </div>
  );
}
