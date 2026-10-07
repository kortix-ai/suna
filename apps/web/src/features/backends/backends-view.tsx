'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import Link from '@/components/site-link';
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
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { backendHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import type { UiTranslator } from '@/i18n/translator';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { relativeTime } from '@/lib/relative-time';
import { useProjectCan } from '@/lib/use-project-can';
import { getBackendCredentials, type ProjectBackend, type ProjectBackendSize } from '@kortix/sdk';
import { useFeatureFlag, useProjectBackends } from '@kortix/sdk/react';
import {
  BookOpenIcon,
  DatabaseIcon,
  DotsThreeIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState, type MouseEvent } from 'react';
import {
  BackendBackupsDialog,
  BackendOperationBadge,
  ResizeBackendDialog,
  backendSizeLabel,
} from './backend-dialogs';

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
  if (code === 'backend_limit') return t.raw('textd784a0fa435a');
  if (code === 'backend_name_taken') return t('textd55e9ebeaa95', { value0: name });
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
    <>
      <CapabilityPageShell
        title={t.raw('text26cbb889e198')}
        description={t.raw('text8dd10daddd77')}
        action={
          <div className="flex min-w-0 items-center gap-2">
            {/* New tab: this page is often open over live work. */}
            <Button asChild variant="secondary" size="sm" className="gap-1.5">
              <Link
                href="/docs/feature-flags/backends"
                target="_blank"
                rel="noreferrer"
                prefetch={false}
              >
                <BookOpenIcon className="size-3.5 shrink-0" />
                {t.raw('text7af023c43013')}
              </Link>
            </Button>
            {gate.enabled && canWrite && list?.length ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <PlusIcon className="size-3.5" />
                {t.raw('textc6af0b77ba25')}
              </Button>
            ) : null}
          </div>
        }
      >
        {gate.isLoading ? (
          <BackendsSkeleton />
        ) : !gate.enabled ? (
          <FeatureGateScreen
            featureName="Backends"
            internalOnly
            description={t.raw('text8dd10daddd77')}
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
          <BackendsTable
            projectId={projectId}
            backends={list}
            canWrite={canWrite}
            onDelete={(id) => backends.remove.mutateAsync(id)}
            deleting={backends.remove.isPending}
            onResize={(backendId, size) => backends.resize.mutateAsync({ backendId, ...size })}
            resizing={backends.resize.isPending}
            onRestore={(backendId, snapshotId) =>
              backends.restore.mutateAsync({ backendId, snapshotId })
            }
            restoring={backends.restore.isPending}
          />
        ) : (
          <EmptyState
            icon={DatabaseIcon}
            title={t.raw('text311cc7fed7c7')}
            description={canWrite ? t.raw('text1724fdec043c') : t.raw('texta5ca25099e19')}
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
      </CapabilityPageShell>

      {createOpen ? (
        <CreateBackendModal
          onOpenChange={setCreateOpen}
          isPending={backends.create.isPending}
          onCreate={(name) => backends.create.mutateAsync({ name })}
        />
      ) : null}
    </>
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
            <ModalDescription>{t.raw('texte65ec54500c8')}</ModalDescription>
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
                {apiError ?? t.raw('text502d7f23fab3')}
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
  onResize,
  resizing,
  onRestore,
  restoring,
}: {
  projectId: string;
  backends: ProjectBackend[];
  canWrite: boolean;
  onDelete: (backendId: string) => Promise<unknown>;
  deleting: boolean;
  onResize: (backendId: string, size: ProjectBackendSize) => Promise<unknown>;
  resizing: boolean;
  onRestore: (backendId: string, snapshotId: string) => Promise<unknown>;
  restoring: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [pendingDelete, setPendingDelete] = useState<ProjectBackend | null>(null);
  // Hold the id, not the row: the dialog reads the live row, which the list polls.
  const [resizeId, setResizeId] = useState<string | null>(null);
  const [backupsId, setBackupsId] = useState<string | null>(null);
  const resizeTarget = backends.find((row) => row.backend_id === resizeId);
  const backupsTarget = backends.find((row) => row.backend_id === backupsId);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.raw('textdcd1d5223f73')}</TableHead>
            <TableHead>{t.raw('text920e413c7d41')}</TableHead>
            <TableHead>{t.raw('text1af851907331')}</TableHead>
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
              onResize={() => setResizeId(backend.backend_id)}
              onBackups={() => setBackupsId(backend.backend_id)}
            />
          ))}
        </TableBody>
      </Table>

      {resizeTarget ? (
        <ResizeBackendDialog
          backend={resizeTarget}
          isPending={resizing}
          onOpenChange={(open) => !open && setResizeId(null)}
          onResize={(size) => onResize(resizeTarget.backend_id, size)}
        />
      ) : null}
      {backupsTarget ? (
        <BackendBackupsDialog
          projectId={projectId}
          backend={backupsTarget}
          canWrite={canWrite}
          restoring={restoring}
          onOpenChange={(open) => !open && setBackupsId(null)}
          onRestore={(snapshotId) => onRestore(backupsTarget.backend_id, snapshotId)}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deleting && setPendingDelete(null)}
        title={t.raw('textf2e1ab3c0d51')}
        description={t('texta593a9f33e01', { value0: pendingDelete?.name ?? '' })}
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

export function BackendStatusBadge({ backend }: { backend: ProjectBackend }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  if (backend.operation) return <BackendOperationBadge />;
  if (backend.status === 'provisioning')
    return (
      <Badge variant="warning" className="gap-1.5">
        <Loading className="size-3 shrink-0" />
        {t.raw('textc2b1b8e2e039')}
      </Badge>
    );
  if (backend.status === 'running')
    return <Badge variant="success">{t.raw('textf4ccae29e1bb')}</Badge>;
  if (backend.status === 'error')
    return <Badge variant="destructive">{t.raw('text54a0e8c17ebb')}</Badge>;
  return <Badge variant="muted">{t.raw('textb48ff39c2e0f')}</Badge>;
}

function BackendRow({
  projectId,
  backend,
  canWrite,
  onDelete,
  onResize,
  onBackups,
}: {
  projectId: string;
  backend: ProjectBackend;
  canWrite: boolean;
  onDelete: () => void;
  onResize: () => void;
  onBackups: () => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const href = backendHref(projectId, backend.backend_id);

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      successToast(done);
    } catch {
      errorToast(t.raw('text4cb23f3c3b90'));
    }
  };

  // One click anywhere on the row opens the backend; the name stays a real
  // link for the keyboard and for "open in new tab".
  const openRow = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.defaultPrevented || window.getSelection()?.toString()) return;
    if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener');
    else router.push(href);
  };
  // The copy button and the menu act on their own. React events bubble through
  // portals, so the menu's items would otherwise also open the row.
  const own = (event: MouseEvent) => event.stopPropagation();

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
    <TableRow
      data-testid="backend-row"
      data-backend-name={backend.name}
      className="cursor-pointer"
      onClick={openRow}
    >
      <TableCell className="font-medium">
        <Link href={href} onClick={own} className="focus-visible:underline">
          {backend.name}
        </Link>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <BackendStatusBadge backend={backend} />
          {backend.status === 'error' && backend.error ? (
            <span className="text-destructive max-w-xs text-xs break-words">{backend.error}</span>
          ) : null}
          {!backend.operation && backend.last_operation_error ? (
            <span className="text-destructive max-w-xs text-xs break-words" role="alert">
              {backend.last_operation_error}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground whitespace-nowrap">
        {backendSizeLabel(backend, t)}
      </TableCell>
      {/* `w-full max-w-0`: the URL takes whatever width the other columns
          leave and truncates, so the row's menu never scrolls out of view. */}
      <TableCell className="w-full max-w-0">
        {backend.url ? (
          <span className="flex items-center gap-1">
            <code className="text-muted-foreground min-w-0 truncate font-mono text-xs">{backend.url}</code>
            {/* Only the copy button keeps its click; the URL text opens the row like any cell. */}
            <span className="shrink-0" onClick={own}>
              <CopyButton code={backend.url} size="sm" />
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{relativeTime(backend.created_at)}</TableCell>
      <TableCell onClick={own}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={t.raw('text2de7b4934e29')}>
              <DotsThreeIcon className="size-4 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link href={href}>{t.raw('text803f2313cdf4')}</Link>
            </DropdownMenuItem>
            {canWrite ? (
              <DropdownMenuItem disabled={backend.status !== 'running'} onClick={copyEnv}>
                {t.raw('text3f044da00a6f')}
              </DropdownMenuItem>
            ) : null}
            {canWrite ? (
              <DropdownMenuItem
                disabled={backend.status !== 'running' || backend.operation !== null}
                onClick={onResize}
              >
                {t.raw('text5ad9ba3657f2')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={backend.status !== 'running'} onClick={onBackups}>
              {t.raw('textf0e800ed571e')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => copy(backendDeployCommand(backend.name), t.raw('text5c3fa6a80824'))}
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
