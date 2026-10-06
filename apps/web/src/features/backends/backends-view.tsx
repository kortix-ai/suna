'use client';

import Link from '@/components/site-link';
import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { ProjectPageHeader } from '@/features/workspace/project-layout/project-page-header';
import { useTranslations } from '@/i18n/use-translations';
import type { UiTranslator } from '@/i18n/translator';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { relativeTime } from '@/lib/relative-time';
import { useProjectCan } from '@/lib/use-project-can';
import { getBackendCredentials, type ProjectBackend } from '@kortix/sdk';
import { useFeatureFlag, useProjectBackends } from '@kortix/sdk/react';
import {
  ArrowUpRightIcon,
  DatabaseIcon,
  DotsThreeIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';

const NAME_PLACEHOLDER = 'my-backend';

/** Mirrors the API: lowercase letters, digits and dashes, starting with a letter, up to 63 characters. */
export const BACKEND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export function backendDeployCommand(name: string): string {
  return `kortix backends deploy ${name} --dir backends/${name}`;
}

export function backendEnvText(env: Record<string, string>): string {
  return [
    `CONVEX_SELF_HOSTED_URL=${env.CONVEX_SELF_HOSTED_URL ?? ''}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? ''}`,
  ].join('\n');
}

/** Turns an API error into a sentence. `backend_limit` and `backend_name_taken` are the 409 codes. */
export function backendCreateError(error: unknown, name: string, t: UiTranslator): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'backend_limit')
    return t.raw('textd784a0fa435a');
  if (code === 'backend_name_taken')
    return t('textd55e9ebeaa95', { value0: name });
  return error instanceof Error ? error.message : t.raw('text55cb8e9fd5d3');
}

export function BackendsView({ projectId }: { projectId: string }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const gate = useFeatureFlag(projectId, 'backends');
  const backends = useProjectBackends(gate.enabled ? projectId : null);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_BACKEND_WRITE).allowed === true;
  const [createOpen, setCreateOpen] = useState(false);
  const list = backends.data;

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t.raw('text26cbb889e198')} href={`/projects/${projectId}/backends`}>
        {gate.enabled && canWrite && list?.length ? (
          <div className="flex shrink-0 items-center pr-1">
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="size-3.5" />
              {t.raw('textc6af0b77ba25')}
            </Button>
          </div>
        ) : null}
        <Link
          href="/docs/feature-flags/backends"
          target="_blank"
          rel="noopener noreferrer"
          prefetch={false}
          className="text-muted-foreground hover:text-foreground flex w-fit flex-none items-center gap-1 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors"
        >
          {t.raw('text7af023c43013')}
          <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
        </Link>
      </ProjectPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-6 px-4 py-6 pb-20 md:px-8">
          {gate.isLoading ? (
            <BackendsSkeleton />
          ) : !gate.enabled ? (
            <FeatureGateScreen
              featureName="Backends"
              description={t.raw(
                'text8dd10daddd77',
              )}
            />
          ) : backends.isLoading ? (
            <BackendsSkeleton />
          ) : backends.isError ? (
            <ErrorState
              size="sm"
              title={t.raw('textaca8aae25be5')}
              description={(backends.error as Error).message}
              action={
                <Button size="sm" variant="outline" onClick={() => backends.refetch()}>
                  {t.raw('textd8b8392e2c54')}
                </Button>
              }
            />
          ) : list?.length ? (
            <>
              <p className="text-muted-foreground max-w-prose text-sm">
                {t.raw(
                  'text8dd10daddd77',
                )}
              </p>
              <BackendsTable
                projectId={projectId}
                backends={list}
                canWrite={canWrite}
                onDelete={(id) => backends.remove.mutateAsync(id)}
                deleting={backends.remove.isPending}
              />
            </>
          ) : (
            <EmptyState
              icon={DatabaseIcon}
              title={t.raw('text311cc7fed7c7')}
              description={
                canWrite
                  ? t.raw('text1724fdec043c')
                  : t.raw('texta5ca25099e19')
              }
              action={
                canWrite ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <PlusIcon className="size-3.5" />
                    {t.raw('textc6af0b77ba25')}
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      </div>

      {createOpen ? (
        <CreateBackendModal
          onOpenChange={setCreateOpen}
          isPending={backends.create.isPending}
          onCreate={(name) => backends.create.mutateAsync({ name })}
        />
      ) : null}
    </div>
  );
}

function BackendsSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full rounded-md" />
      ))}
    </div>
  );
}

function CreateBackendModal({
  onOpenChange,
  onCreate,
  isPending,
}: {
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<unknown>;
  isPending: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [name, setName] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);
  const valid = BACKEND_NAME_PATTERN.test(name);
  const showFormatError = name.length > 0 && !valid;

  const submit = async () => {
    if (!valid || isPending) return;
    setApiError(null);
    try {
      await onCreate(name);
      successToast(t.raw('text7129d391fd25'));
      onOpenChange(false);
    } catch (error) {
      setApiError(backendCreateError(error, name, t));
    }
  };

  return (
    <Modal open onOpenChange={(open) => !isPending && onOpenChange(open)}>
      <ModalContent className="lg:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <ModalHeader>
            <ModalTitle>{t.raw('textc6af0b77ba25')}</ModalTitle>
            <ModalDescription>
              {t.raw('texte65ec54500c8')}
            </ModalDescription>
          </ModalHeader>
          <ModalBody>
            <div className="space-y-2">
              <Label htmlFor="backend-name">{t.raw('textdcd1d5223f73')}</Label>
              <Input
                id="backend-name"
                autoFocus
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setApiError(null);
                }}
                placeholder={NAME_PLACEHOLDER}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={showFormatError || apiError !== null}
              />
              <p
                className={
                  showFormatError || apiError
                    ? 'text-destructive text-xs'
                    : 'text-muted-foreground text-xs'
                }
                role={apiError ? 'alert' : undefined}
              >
                {apiError ??
                  t.raw(
                    'text502d7f23fab3',
                  )}
              </p>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => onOpenChange(false)}
            >
              {t.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={!valid || isPending}>
              {isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t.raw('textc6af0b77ba25')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

function BackendsTable({
  projectId,
  backends,
  canWrite,
  onDelete,
  deleting,
}: {
  projectId: string;
  backends: ProjectBackend[];
  canWrite: boolean;
  onDelete: (backendId: string) => Promise<unknown>;
  deleting: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [pendingDelete, setPendingDelete] = useState<ProjectBackend | null>(null);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.raw('textdcd1d5223f73')}</TableHead>
            <TableHead>{t.raw('text920e413c7d41')}</TableHead>
            <TableHead>{t.raw('texte7a241debad5')}</TableHead>
            <TableHead>{t.raw('textd70b9e24bca2')}</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">{t.raw('textff8059dc6752')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {backends.map((backend) => (
            <BackendRow
              key={backend.backend_id}
              projectId={projectId}
              backend={backend}
              canWrite={canWrite}
              onDelete={() => setPendingDelete(backend)}
            />
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deleting && setPendingDelete(null)}
        title={t.raw('textf2e1ab3c0d51')}
        description={t(
          'texta593a9f33e01',
          { value0: pendingDelete?.name ?? '' },
        )}
        confirmLabel={t.raw('texte2d0a54968ea')}
        confirmVariant="destructive"
        isPending={deleting}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await onDelete(pendingDelete.backend_id);
            successToast(t.raw('textb19cc2aecb0e'));
            setPendingDelete(null);
          } catch (error) {
            errorToast(error instanceof Error ? error.message : t.raw('text278204d7dab9'));
          }
        }}
      />
    </>
  );
}

function BackendStatusBadge({ backend }: { backend: ProjectBackend }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  if (backend.status === 'provisioning')
    return (
      <Badge variant="warning" className="gap-1.5">
        <Loading className="size-3 shrink-0" />
        {t.raw('textc2b1b8e2e039')}
      </Badge>
    );
  if (backend.status === 'running') return <Badge variant="success">{t.raw('textf4ccae29e1bb')}</Badge>;
  if (backend.status === 'error')
    return <Badge variant="destructive">{t.raw('text54a0e8c17ebb')}</Badge>;
  return <Badge variant="muted">{t.raw('textb48ff39c2e0f')}</Badge>;
}

function BackendRow({
  projectId,
  backend,
  canWrite,
  onDelete,
}: {
  projectId: string;
  backend: ProjectBackend;
  canWrite: boolean;
  onDelete: () => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      successToast(done);
    } catch {
      errorToast(t.raw('text4cb23f3c3b90'));
    }
  };

  // The admin key goes from the API response straight to the clipboard. It is never rendered or stored.
  const copyEnv = async () => {
    try {
      const credentials = await getBackendCredentials(projectId, backend.backend_id);
      await copy(backendEnvText(credentials.env), t.raw('textaad2d1b4576e'));
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t.raw('text9962d69a4916'));
    }
  };

  return (
    <TableRow data-testid="backend-row" data-backend-name={backend.name}>
      <TableCell className="font-medium">{backend.name}</TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <BackendStatusBadge backend={backend} />
          {backend.status === 'error' && backend.error ? (
            <span className="text-destructive max-w-xs text-xs break-words">{backend.error}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        {backend.url ? (
          <span className="flex items-center gap-1">
            <code className="text-muted-foreground truncate font-mono text-xs">{backend.url}</code>
            <CopyButton code={backend.url} size="sm" className="shrink-0" />
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{relativeTime(backend.created_at)}</TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={t.raw('text2de7b4934e29')}>
              <DotsThreeIcon className="size-4 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {canWrite ? (
              <DropdownMenuItem disabled={backend.status !== 'running'} onClick={copyEnv}>
                {t.raw('text3f044da00a6f')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() =>
                copy(backendDeployCommand(backend.name), t.raw('text5c3fa6a80824'))
              }
            >
              {t.raw('text21de8d7ddc3e')}
            </DropdownMenuItem>
            {canWrite ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <TrashIcon className="size-3.5 shrink-0" />
                  {t.raw('textf2e1ab3c0d51')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
