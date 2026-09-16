'use client';

import {
  createConnector,
  getDiscoverConnector,
  type ConnectorAuthorizationStrategy,
  type ConnectorDraftInput,
  type DiscoverConnector,
} from '@kortix/sdk';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SplitSheetBody,
  SplitSheetClose,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetTitle,
} from '@/components/ui/split-sheet';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import {
  connectorAuthorizationStrategyIsEditable,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  proposeConnectorConnectionSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';

import { surfacesRecommendedFirst } from '../detail/connector-detail-copy';

/**
 * Add a catalogue connector — a SPLIT column of the page, one submit.
 *
 * Renders `SplitSheetContent`, so it must sit inside the catalogue page's
 * `<SplitSheet>` root. Opening it narrows the page instead of covering it —
 * no overlay, no dimming, the catalogue stays readable beside the form
 * (Jay: "it should open the UI on the right side like a side panel, on the
 * same page").
 *
 * This replaced a two-modal chain (surface picker → name/slug modal). The
 * whole decision lives on one surface: the recommended way in (MCP where
 * addable) is preselected, the connection is prenamed, and the choices most
 * people never change stay one glance away — including the ACCOUNTS choice
 * (one shared account vs each member's own; the install itself is always
 * project-wide — Marko, 2026-09-15).
 */
export function DiscoverAddSheet({
  projectId,
  connector,
  existingSlugs,
  canWrite,
  onAdded,
  initialStrategy,
}: {
  projectId: string;
  /** The catalogue entry this page shows. Fixed for the page's lifetime. */
  connector: DiscoverConnector;
  existingSlugs: readonly string[];
  canWrite: boolean;
  /** Slug omitted when the manifest write succeeded but sync did not. */
  onAdded: (slug?: string) => void;
  /** Preselected Install-for scope — the card's Install dropdown passes the
   *  choice the user already made so the panel does not re-ask. */
  initialStrategy?: ConnectorAuthorizationStrategy;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const detailQuery = useQuery({
    // Same key the catalogue page uses — one fetch, shared cache.
    queryKey: ['discover-connector-detail', projectId, connector.id],
    queryFn: () => getDiscoverConnector(projectId, connector.id),
    staleTime: 15 * 60_000,
  });

  const variants = surfacesRecommendedFirst(detailQuery.data?.variants ?? []);
  const addable = variants.filter((variant) => variant.connector);
  const recommended = addable[0] ?? null;

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<ConnectorAuthorizationStrategy>(
    initialStrategy ?? 'project',
  );
  // The sheet mounts before the choice arrives (the panel is persistent);
  // adopt a LATER preselection, but never fight an explicit in-panel pick —
  // the prop only changes when a fresh Install dropdown choice lands.
  useEffect(() => {
    if (initialStrategy) setStrategy(initialStrategy);
  }, [initialStrategy]);

  const selected = addable.find((variant) => variant.id === pickedId) ?? recommended;
  const name = nameDraft ?? connector.name;
  const slug = proposeConnectorConnectionSlug(name, existingSlugs);

  const add = useMutation({
    mutationFn: async () => {
      const template = selected?.connector;
      if (!template) throw new Error('Pick a way to connect first');
      const auth = template.auth
        ? {
            type: template.auth.type,
            in: template.auth.in,
            ...(template.auth.name ? { name: template.auth.name } : {}),
            ...(template.auth.prefix ? { prefix: template.auth.prefix } : {}),
          }
        : undefined;
      const draft: ConnectorDraftInput = {
        slug,
        name: name.trim(),
        provider: template.provider,
        authorization_strategy: connectorAuthorizationStrategyIsEditable(template.provider)
          ? strategy
          : 'project',
        ...(template.spec ? { spec: template.spec } : {}),
        ...(template.url ? { url: template.url } : {}),
        ...(template.transport ? { transport: template.transport } : {}),
        ...(template.endpoint ? { endpoint: template.endpoint } : {}),
        ...(auth ? { auth } : {}),
      };
      const createDraft = createOnlyConnectorDraft(draft);
      const result = await createConnector(projectId, createDraft);
      return {
        slug: createDraft.slug,
        name: createDraft.name ?? createDraft.slug,
        syncError: connectorSyncErrorForSlug(result, createDraft.slug),
      };
    },
    onSuccess: (result) => {
      if (result.syncError) {
        // The connector EXISTS — sync failing (usually missing auth, an HTTP
        // 401) is exactly what its page's connect dialog fixes. Hand the slug
        // over so the caller still opens it (Jay: "whatever slug is created,
        // it should open that slug").
        warningToast(tI18nComplete('text33a484a069ac', { value0: result.name }));
        onAdded(result.slug);
        return;
      }
      successToast(tI18nComplete('text08e6480e9b78', { value0: result.name }));
      onAdded(result.slug);
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text37479e6422d0')),
  });

  const strategyEditable = selected?.connector
    ? connectorAuthorizationStrategyIsEditable(selected.connector.provider)
    : false;

  return (
    <SplitSheetContent>
      <SplitSheetHeader>
        <SplitSheetTitle>
          {tI18nComplete('text641cf33675f8', { value0: connector.name })}
        </SplitSheetTitle>
        <SplitSheetDescription>{tI18nComplete.raw('textee1ee9e008b4')}</SplitSheetDescription>
      </SplitSheetHeader>

      <SplitSheetBody className="space-y-5">
        {detailQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-14 w-full rounded-md" />
            ))}
          </div>
        ) : detailQuery.isError ? (
          <InfoBanner
            tone="destructive"
            title={tI18nComplete.raw('textc19b3005db37')}
            action={
              <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
                {tI18nComplete.raw('text942087cc2d41')}
              </Button>
            }
          >
            {(detailQuery.error as Error)?.message ?? tI18nComplete.raw('textd157dd6a3627')}
          </InfoBanner>
        ) : addable.length === 0 ? (
          <InfoBanner tone="neutral" title={tI18nComplete.raw('textf3c16c11f690')}>
            {tI18nComplete.raw('text87f2fa0e1edc')}
          </InfoBanner>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="discover-add-name">
                {tI18nComplete.raw('textdcd1d5223f73')}
              </FieldLabel>
              <Input
                id="discover-add-name"
                value={name}
                onChange={(event) => setNameDraft(event.target.value)}
                maxLength={255}
                disabled={add.isPending || !canWrite}
              />
              <FieldDescription>
                {tI18nComplete.raw('text9cd2dee87dd6')}{' '}
                <code className="font-mono">{slug || '…'}</code>.
              </FieldDescription>
            </Field>

            {/* The surface choice hides unless there IS a choice. One
                addable surface = zero decisions on screen. */}
            {addable.length > 1 ? (
              <fieldset className="space-y-2">
                <legend className="text-foreground text-sm font-medium">
                  {tI18nComplete.raw('texte0e9f2833427')}
                </legend>
                <RadioGroup
                  value={selected?.id ?? ''}
                  onValueChange={setPickedId}
                  className="gap-2"
                >
                  {addable.map((variant, index) => (
                    <label
                      key={variant.id}
                      htmlFor={`surface-${variant.id}`}
                      className="bg-popover hover:bg-accent flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-2.5 transition-colors"
                    >
                      <RadioGroupItem
                        id={`surface-${variant.id}`}
                        value={variant.id}
                        className="mt-0.5"
                        disabled={add.isPending}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-foreground truncate text-sm font-medium">
                            {variant.name}
                          </span>
                          {index === 0 ? (
                            <Badge variant="kortix" size="xs">
                              {tI18nComplete.raw('textd70604e84304')}
                            </Badge>
                          ) : null}
                          <Badge variant="outline" size="xs">
                            {variant.kind === 'openapi' ? 'OpenAPI' : variant.kind.toUpperCase()}
                          </Badge>
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {variant.requiresAuth
                            ? tI18nComplete.raw('text2814edeb3957')
                            : tI18nComplete.raw('text572ca3ee73f4')}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
            ) : null}

            {/* The ACCOUNTS choice — the connector installs for the whole
                project either way (Marko, 2026-09-15); this only decides
                whether everyone shares ONE account or each member signs in
                with their own. The two options ARE the two authorization
                owners. */}
            {strategyEditable ? (
              <fieldset className="space-y-2">
                <legend className="text-foreground text-sm font-medium">
                  {tI18nComplete.raw('text8a7c8b67fe8b')}
                </legend>
                <RadioGroup
                  value={strategy}
                  onValueChange={(next) => setStrategy(next as ConnectorAuthorizationStrategy)}
                  className="gap-2"
                >
                  <label
                    htmlFor="install-for-project"
                    className="bg-popover hover:bg-accent flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-2.5 transition-colors"
                  >
                    <RadioGroupItem
                      id="install-for-project"
                      value="project"
                      className="mt-0.5"
                      disabled={add.isPending}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block text-sm font-medium">
                        {tI18nComplete.raw('text20dee4420874')}
                      </span>
                      <span className="text-muted-foreground block text-xs text-pretty">
                        {tI18nComplete('text6dfb578442b2', { value0: connector.name })}
                      </span>
                    </span>
                  </label>
                  <label
                    htmlFor="install-for-me"
                    className="bg-popover hover:bg-accent flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-2.5 transition-colors"
                  >
                    <RadioGroupItem
                      id="install-for-me"
                      value="user"
                      className="mt-0.5"
                      disabled={add.isPending}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block text-sm font-medium">
                        {tI18nComplete.raw('textbcbfbec31cb8')}
                      </span>
                      <span className="text-muted-foreground block text-xs text-pretty">
                        {tI18nComplete('text46657cd49f74', { value0: connector.name })}
                      </span>
                    </span>
                  </label>
                </RadioGroup>
              </fieldset>
            ) : (
              // The provider fixes the owner — state it instead of rendering
              // a dead control.
              <p className="text-muted-foreground text-xs text-pretty">
                {tI18nComplete.raw('text14f151094a7c')}
              </p>
            )}
          </>
        )}
      </SplitSheetBody>

      <SplitSheetFooter className="justify-between">
        <SplitSheetClose asChild>
          <Button type="button" variant="outline-ghost" size="sm" disabled={add.isPending}>
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
        </SplitSheetClose>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => add.mutate()}
          disabled={!canWrite || add.isPending || !selected?.connector || !name.trim() || !slug}
        >
          {add.isPending ? <Loading className="size-4 shrink-0" /> : null}
          {tI18nComplete.raw('texta6ef2483d6fb')}
        </Button>
      </SplitSheetFooter>
    </SplitSheetContent>
  );
}
