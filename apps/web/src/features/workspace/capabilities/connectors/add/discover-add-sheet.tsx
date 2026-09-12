'use client';

import {
  createConnector,
  getDiscoverConnector,
  type ConnectorDraftInput,
  type ConnectorAuthorizationStrategy,
  type DiscoverConnector,
} from '@kortix/sdk';
import { CaretDownIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  SplitSheetBody,
  SplitSheetClose,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetTitle,
} from '@/components/ui/split-sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import {
  connectorAuthorizationStrategyIsEditable,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  proposeConnectorConnectionSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { AuthorizationStrategyField } from '@/features/workspace/customize/sections/connector-connection-modal';

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
 * people never change sit under one Advanced disclosure.
 */
export function DiscoverAddSheet({
  projectId,
  connector,
  existingSlugs,
  canWrite,
  onAdded,
}: {
  projectId: string;
  /** The catalogue entry this page shows. Fixed for the page's lifetime. */
  connector: DiscoverConnector;
  existingSlugs: readonly string[];
  canWrite: boolean;
  /** Slug omitted when the manifest write succeeded but sync did not. */
  onAdded: (slug?: string) => void;
}) {
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
  const [strategy, setStrategy] = useState<ConnectorAuthorizationStrategy>('project');

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
        warningToast(`${result.name} was added, but synchronization failed: ${result.syncError}`);
        onAdded();
        return;
      }
      successToast(`${result.name} added`);
      onAdded(result.slug);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add the connector'),
  });

  const strategyEditable = selected?.connector
    ? connectorAuthorizationStrategyIsEditable(selected.connector.provider)
    : false;

  return (
    <SplitSheetContent>
      <SplitSheetHeader>
        <SplitSheetTitle>Add {connector.name}</SplitSheetTitle>
        <SplitSheetDescription>
          A connector can be added more than once — each connection gets its own name.
        </SplitSheetDescription>
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
            title="Couldn’t load the connection options"
            action={
              <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {(detailQuery.error as Error)?.message ?? 'The catalogue request failed.'}
          </InfoBanner>
        ) : addable.length === 0 ? (
          <InfoBanner tone="neutral" title="Nothing addable">
            This entry publishes documentation only — no surface Kortix can connect to.
          </InfoBanner>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="discover-add-name">Name</FieldLabel>
              <Input
                id="discover-add-name"
                value={name}
                onChange={(event) => setNameDraft(event.target.value)}
                maxLength={255}
                disabled={add.isPending || !canWrite}
              />
              <FieldDescription>
                Saved as <code className="font-mono">{slug || '…'}</code>.
              </FieldDescription>
            </Field>

            {/* The surface choice hides unless there IS a choice. One
                addable surface = zero decisions on screen. */}
            {addable.length > 1 ? (
              <fieldset className="space-y-2">
                <legend className="text-foreground text-sm font-medium">How it connects</legend>
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
                              Recommended
                            </Badge>
                          ) : null}
                          <Badge variant="outline" size="xs">
                            {variant.kind === 'openapi' ? 'OpenAPI' : variant.kind.toUpperCase()}
                          </Badge>
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {variant.requiresAuth
                            ? 'Needs a sign-in or credential after adding'
                            : 'No sign-in needed'}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
            ) : null}

            <Disclosure variant="outline">
              <DisclosureTrigger variant="outline">
                <Button
                  variant="popover"
                  className="group/trigger flex w-full items-center justify-between rounded-none px-3.5 py-2.5"
                >
                  <span className="text-sm font-medium">Advanced</span>
                  <CaretDownIcon className="size-4 shrink-0 group-aria-expanded/trigger:rotate-180" />
                </Button>
              </DisclosureTrigger>
              <DisclosureContent variant="outline" contentClassName="border-border border-t">
                <div className="px-3.5 py-4">
                  <AuthorizationStrategyField
                    idPrefix="discover-add-sheet"
                    value={strategyEditable ? strategy : 'project'}
                    onChange={setStrategy}
                    disabled={!strategyEditable || add.isPending}
                  />
                </div>
              </DisclosureContent>
            </Disclosure>
          </>
        )}
      </SplitSheetBody>

      <SplitSheetFooter className="justify-between">
        <SplitSheetClose asChild>
          <Button type="button" variant="outline-ghost" size="sm" disabled={add.isPending}>
            Cancel
          </Button>
        </SplitSheetClose>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => add.mutate()}
          disabled={!canWrite || add.isPending || !selected?.connector || !name.trim() || !slug}
        >
          {add.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Add connector
        </Button>
      </SplitSheetFooter>
    </SplitSheetContent>
  );
}
