'use client';

import { useQuery } from '@tanstack/react-query';
import { Key as KeyRound, Power as Plug, Wrench } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

export function AddToProjectDialog({
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
          <DialogTitle>
            Add {item?.title}
            {fixedProjectName ? ` to ${fixedProjectName}` : ''}
          </DialogTitle>
          <DialogDescription>
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddToProjectDialogJsxTextCommitsThis7b891a43',
            )}
            {typeMeta(item?.type ?? '').label.toLowerCase()}{' '}
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddToProjectDialogJsxTextIntoThe7714c57a',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-5">
          {usePicker && (
            <div className="space-y-1.5">
              <span className="text-foreground text-sm font-medium">Project</span>
              <Select value={pickedProjectId} onValueChange={setPickedProjectId}>
                <SelectTrigger>
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
                <p className="text-muted-foreground text-xs">
                  {tI18nHardcoded.raw(
                    'autoComponentsMarketplaceAddToProjectDialogJsxTextYouHavec6bfb213',
                  )}
                </p>
              )}
            </div>
          )}

          {item && item.dependencies.length > 0 && (
            <p className="text-muted-foreground text-sm">
              {tI18nHardcoded.raw(
                'autoComponentsMarketplaceAddToProjectDialogJsxTextAlsoInstallsac6dcc9a',
              )}
              <span className="text-foreground">{item.dependencies.join(', ')}</span>
            </p>
          )}

          {hasCaps ? (
            <div className="border-border bg-muted/30 rounded-2xl border p-3">
              <p className="text-foreground text-xs font-medium">
                {tI18nHardcoded.raw(
                  'autoComponentsMarketplaceAddToProjectDialogJsxTextThisItem2bb697bd',
                )}
              </p>
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
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsMarketplaceAddToProjectDialogJsxTextNoSpecial521751ba',
              )}
            </p>
          )}
        </div>

        <div className="border-border/60 bg-muted/30 flex items-center justify-end gap-2 border-t px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onInstall} disabled={!targetProjectId || install.isPending}>
            {install.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
