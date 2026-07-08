'use client';

import { useQuery } from '@tanstack/react-query';
import { KeyRound, Plug, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { useInstallMarketplaceItem, useInstalledItems } from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { listProjectsForAccount } from '@kortix/sdk/projects-client';
import {
  buildInstallSuccessSummary,
  capabilityCount,
  hasCapabilities,
  isInstallDisabled,
  projectMarketplaceHref,
} from './marketplace-install';
import { typeMeta } from './marketplace-meta';

export function AddToProjectModal({
  item,
  open,
  onOpenChange,
  fixedProjectId,
  fixedProjectName,
}: {
  item: MarketplaceItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, install straight into this project (no picker). */
  fixedProjectId?: string;
  fixedProjectName?: string;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const router = useRouter();
  const { user } = useAuth();
  const usePicker = !fixedProjectId;
  const [pickedProjectId, setPickedProjectId] = useState('');
  const install = useInstallMarketplaceItem();

  const projectsQuery = useQuery({
    queryKey: ['projects', 'all-for-marketplace'],
    queryFn: () => listProjectsForAccount(),
    enabled: !!user && open && usePicker,
    staleTime: 30_000,
  });
  const projects = projectsQuery.data ?? [];

  useEffect(() => {
    if (open && usePicker && !pickedProjectId && projects.length > 0) {
      setPickedProjectId(projects[0].project_id);
    }
  }, [open, usePicker, projects, pickedProjectId]);

  const targetProjectId = fixedProjectId ?? pickedProjectId;
  const caps = item?.capabilities;
  const showCaps = hasCapabilities(caps);
  const capCount = capabilityCount(caps);

  const installedQuery = useInstalledItems(targetProjectId || null);
  const alreadyInstalled = !!(
    item && installedQuery.data?.some((installed) => installed.name === item.name)
  );

  const disabled = isInstallDisabled({
    hasItem: !!item,
    targetProjectId,
    pending: install.isPending,
  });

  const guardedOpenChange = (next: boolean) => {
    // Block the modal from closing mid-flight — losing the pending/error
    // feedback would leave the user unsure whether the install landed.
    if (install.isPending) return;
    onOpenChange(next);
  };

  const onInstall = async () => {
    if (!item || disabled) return;
    try {
      const res = await install.mutateAsync({ projectId: targetProjectId, id: item.id });
      const summary = buildInstallSuccessSummary(item.title, res);
      successToast(summary.title, {
        description: summary.description,
        button: (
          <Button size="sm" onClick={() => router.push(projectMarketplaceHref(targetProjectId))}>
            View in project
          </Button>
        ),
      });
      onOpenChange(false);
    } catch (e) {
      errorToast('Install failed', { description: (e as Error).message });
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onInstall();
  };

  return (
    <Modal open={open} onOpenChange={guardedOpenChange}>
      <ModalContent className="lg:max-w-md" closeOnOutsideClick={!install.isPending}>
        <ModalHeader>
          <ModalTitle>
            Add {item?.title}
            {fixedProjectName ? ` to ${fixedProjectName}` : ''}
          </ModalTitle>
          <ModalDescription>
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddToProjectModalJsxTextCommitsThis7b891a43',
            )}
            {typeMeta(item?.type ?? '').label.toLowerCase()}{' '}
            {tI18nHardcoded.raw('autoComponentsMarketplaceAddToProjectModalJsxTextIntoThe7714c57a')}
          </ModalDescription>
        </ModalHeader>

        <form onSubmit={handleSubmit}>
          <ModalBody>
            <FieldGroup className="gap-4">
              {usePicker && (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="mp-project">Project</FieldLabel>
                  <Select value={pickedProjectId} onValueChange={setPickedProjectId}>
                    <SelectTrigger id="mp-project">
                      <SelectValue
                        placeholder={projectsQuery.isLoading ? 'Loading…' : 'Choose a project'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.project_id} value={p.project_id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!projectsQuery.isLoading && projects.length === 0 && (
                    <FieldDescription>
                      {tI18nHardcoded.raw(
                        'autoComponentsMarketplaceAddToProjectModalJsxTextYouHavec6bfb213',
                      )}
                    </FieldDescription>
                  )}
                </Field>
              )}

              {alreadyInstalled && (
                <div className="bg-popover flex items-center gap-2 rounded-md border px-4 py-2.5">
                  <Badge variant="success" size="sm">
                    Already installed
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    Adding again reinstalls it from source.
                  </span>
                </div>
              )}

              {item && item.dependencies.length > 0 && (
                <FieldDescription>
                  {tI18nHardcoded.raw(
                    'autoComponentsMarketplaceAddToProjectModalJsxTextAlsoInstallsac6dcc9a',
                  )}
                  <span className="text-foreground">{item.dependencies.join(', ')}</span>
                </FieldDescription>
              )}

              {showCaps ? (
                <Field variant="outline">
                  <FieldContent>
                    <div className="flex items-center gap-2">
                      <FieldTitle>
                        {tI18nHardcoded.raw(
                          'autoComponentsMarketplaceAddToProjectModalJsxTextThisItem2bb697bd',
                        )}
                      </FieldTitle>
                      <Badge variant="outline" size="sm">
                        {capCount}
                      </Badge>
                    </div>
                    <ul className="mt-2 space-y-1.5">
                      {caps?.secrets.map((s) => (
                        <li key={s} className="flex items-center gap-2.5">
                          <span className="bg-kortix-yellow/15 text-kortix-yellow flex size-6 shrink-0 items-center justify-center rounded-sm">
                            <KeyRound className="size-3.5" />
                          </span>
                          <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                            {s}
                          </span>
                          <Badge variant="outline" size="sm">
                            Secret
                          </Badge>
                        </li>
                      ))}
                      {caps?.connectors.map((c) => (
                        <li key={c} className="flex items-center gap-2.5">
                          <span className="bg-kortix-blue/15 text-kortix-blue flex size-6 shrink-0 items-center justify-center rounded-sm">
                            <Plug className="size-3.5" />
                          </span>
                          <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                            {c}
                          </span>
                          <Badge variant="outline" size="sm">
                            Connector
                          </Badge>
                        </li>
                      ))}
                      {caps?.tools.map((t) => (
                        <li key={t} className="flex items-center gap-2.5">
                          <span className="bg-kortix-orange/15 text-kortix-orange flex size-6 shrink-0 items-center justify-center rounded-sm">
                            <Wrench className="size-3.5" />
                          </span>
                          <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                            {t}
                          </span>
                          <Badge variant="outline" size="sm">
                            Tool
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </FieldContent>
                </Field>
              ) : (
                <FieldDescription>
                  {tI18nHardcoded.raw(
                    'autoComponentsMarketplaceAddToProjectModalJsxTextNoSpecial521751ba',
                  )}
                </FieldDescription>
              )}
            </FieldGroup>
          </ModalBody>

          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              disabled={install.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={disabled}>
              {install.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
              {install.isPending ? 'Adding…' : alreadyInstalled ? 'Reinstall' : 'Add'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
