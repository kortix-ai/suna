'use client';

import { useQuery } from '@tanstack/react-query';
import { KeyRound, Plug, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
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
import { useInstallMarketplaceItem } from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { listProjectsForAccount } from '@/lib/projects-client';
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
  const hasCaps = !!caps && caps.secrets.length + caps.connectors.length + caps.tools.length > 0;

  const onInstall = async () => {
    if (!item || !targetProjectId) return;
    try {
      const res = await install.mutateAsync({ projectId: targetProjectId, id: item.id });
      successToast(`Added ${item.title}`, {
        description: `Committed ${res.file_count} file${res.file_count === 1 ? '' : 's'} — live in the next session.`,
      });
      onOpenChange(false);
    } catch (e) {
      errorToast('Install failed', { description: (e as Error).message });
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
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

            {item && item.dependencies.length > 0 && (
              <FieldDescription>
                {tI18nHardcoded.raw(
                  'autoComponentsMarketplaceAddToProjectModalJsxTextAlsoInstallsac6dcc9a',
                )}
                <span className="text-foreground">{item.dependencies.join(', ')}</span>
              </FieldDescription>
            )}

            {hasCaps ? (
              <Field variant="outline">
                <FieldContent>
                  <FieldTitle>
                    {tI18nHardcoded.raw(
                      'autoComponentsMarketplaceAddToProjectModalJsxTextThisItem2bb697bd',
                    )}
                  </FieldTitle>
                  <ul className="text-muted-foreground mt-2 space-y-1.5 text-sm">
                    {caps!.secrets.map((s) => (
                      <li key={s} className="flex items-center gap-2">
                        <KeyRound className="size-3.5 shrink-0" />
                        <span className="font-mono text-xs">{s}</span>
                      </li>
                    ))}
                    {caps!.connectors.map((c) => (
                      <li key={c} className="flex items-center gap-2">
                        <Plug className="size-3.5 shrink-0" />
                        {c}
                      </li>
                    ))}
                    {caps!.tools.map((t) => (
                      <li key={t} className="flex items-center gap-2">
                        <Wrench className="size-3.5 shrink-0" />
                        {t}
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
          <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={onInstall} disabled={!targetProjectId || install.isPending}>
            {install.isPending ? 'Adding…' : 'Add'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
