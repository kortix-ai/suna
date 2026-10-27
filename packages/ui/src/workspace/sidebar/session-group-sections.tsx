'use client';

/**
 * Session groups in the sidebar (`session_groups` flag): the project's shared,
 * named folders of sessions, between Pinned and the rest of the list.
 *
 * Each group is a section. Its rows load when it is open (one paged list per
 * group, any starter, any depth), and its open state is the viewer's own,
 * beside the other sections in the session-filter store. A session moves into
 * a group from its `⋯` menu or by dragging its row onto the group; a group
 * moves by dragging its header onto another group, or with Move up / Move
 * down. Dragging a row onto the rest of the list takes it out of its group.
 */

import { ApiError, type ProjectSession, type ProjectSessionGroup } from '@kortix/sdk';
import {
  useCreateProjectSessionGroup,
  useDeleteProjectSessionGroup,
  useProjectSessions,
  useRenameProjectSessionGroup,
  useReorderProjectSessionGroups,
  useSetProjectSessionGroup,
} from '@kortix/sdk/react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretRightIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  PencilSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import { errorToast, successToast } from '../../primitives/toast';
import { moveGroupBy, moveGroupTo } from './session-group-order';
import {
  SESSION_MENU_TRIGGER_CLASS,
  SESSION_ROW_HEIGHT_CLASS,
  SIDEBAR_PAGE_SIZE,
  ShowMoreButton,
} from './session-list-chrome';

/** A dragged session row carries its id under this type. */
const SESSION_DRAG_TYPE = 'application/x-kortix-session';
/** A dragged group header carries its id under this type. */
const GROUP_DRAG_TYPE = 'application/x-kortix-session-group';
/** Mirrors `SESSION_GROUP_NAME_MAX` in `@kortix/api-contract`: the server refuses a longer name. */
const GROUP_NAME_MAX = 80;

/** The collapsed-sections id of one group. */
export function sessionGroupSectionId(groupId: string): string {
  return `group:${groupId}`;
}

/** `onDragStart` of a session row: the row's link drag also carries the session id. */
export function startSessionDrag(event: DragEvent, sessionId: string): void {
  event.dataTransfer.setData(SESSION_DRAG_TYPE, sessionId);
  // A link drag allows only copy and link by default; a drop here is a move.
  event.dataTransfer.effectAllowed = 'all';
}

function dragCarries(event: DragEvent, type: string): boolean {
  return Array.from(event.dataTransfer.types).includes(type);
}

/**
 * A drop target for dragged session rows (and, with `onDropGroup`, dragged
 * group headers). `over` is what is over it right now, for the highlight.
 */
function useDropTarget(handlers: { onDropSession?: (sessionId: string) => void; onDropGroup?: (groupId: string) => void }) {
  const [over, setOver] = useState<'session' | 'group' | null>(null);
  const kindOf = (event: DragEvent) =>
    handlers.onDropSession && dragCarries(event, SESSION_DRAG_TYPE)
      ? 'session'
      : handlers.onDropGroup && dragCarries(event, GROUP_DRAG_TYPE)
        ? 'group'
        : null;
  const props = {
    onDragOver: (event: DragEvent) => {
      const kind = kindOf(event);
      if (!kind) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (over !== kind) setOver(kind);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (event: DragEvent) => {
      const kind = kindOf(event);
      setOver(null);
      if (!kind) return;
      event.preventDefault();
      if (kind === 'session') handlers.onDropSession?.(event.dataTransfer.getData(SESSION_DRAG_TYPE));
      else handlers.onDropGroup?.(event.dataTransfer.getData(GROUP_DRAG_TYPE));
    },
  };
  return { over, props };
}

/** Filing and reordering, with their result toasts. One instance per list. */
export function useSessionGroupActions(projectId: string, groups: readonly ProjectSessionGroup[]) {
  const t = useTranslations('sidebar.sessionGroups');
  const { mutateAsync: file } = useSetProjectSessionGroup(projectId);
  const { mutateAsync: reorder } = useReorderProjectSessionGroups(projectId);
  return useMemo(() => {
    const nameOf = (groupId: string | null) =>
      groupId ? (groups.find((group) => group.group_id === groupId)?.name ?? '') : t('noGroup');
    return {
      /** `toast`: a menu move reports where the row went; a drop shows it in place. */
      move: async (sessionId: string, groupId: string | null, options?: { toast?: boolean }) => {
        try {
          await file({ sessionId, groupId });
          if (options?.toast) successToast(t('moved'), { description: nameOf(groupId) });
        } catch {
          errorToast(t('moveFailed'));
        }
      },
      reorder: async (groupIds: string[] | null) => {
        if (!groupIds) return;
        try {
          await reorder(groupIds);
        } catch {
          errorToast(t('reorderFailed'));
        }
      },
    };
  }, [file, reorder, groups, t]);
}

/**
 * Create a group (`group` null) or rename one. A taken name and the group
 * limit show in the dialog; the dialog closes with a toast once the list holds
 * the change. `onCreated` receives the new group (a row's "New group…" files
 * its session into it).
 */
export function SessionGroupNameModal({
  projectId,
  group,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  group: ProjectSessionGroup | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (group: ProjectSessionGroup) => void;
}) {
  const t = useTranslations('sidebar.sessionGroups');
  const create = useCreateProjectSessionGroup(projectId);
  const rename = useRenameProjectSessionGroup(projectId);
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [syncedFor, setSyncedFor] = useState<[boolean, string | null]>([open, group?.group_id ?? null]);
  if (syncedFor[0] !== open || syncedFor[1] !== (group?.group_id ?? null)) {
    setSyncedFor([open, group?.group_id ?? null]);
    if (open) {
      setValue(group?.name ?? '');
      setProblem(null);
    }
  }

  const pending = create.isPending || rename.isPending;
  const name = value.trim();
  const unchanged = group !== null && name === group.name;

  const submit = async () => {
    if (!name || unchanged || pending) return;
    setProblem(null);
    try {
      if (group) {
        await rename.mutateAsync({ groupId: group.group_id, name });
        successToast(t('renamed'));
      } else {
        const created = await create.mutateAsync({ name });
        successToast(t('created'));
        onCreated?.(created);
      }
      onOpenChange(false);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      setProblem(
        code === 'group_name_taken'
          ? t('nameTaken')
          : code === 'group_limit'
            ? t('limit')
            : t(group ? 'renameFailed' : 'createFailed'),
      );
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{group ? t('rename') : t('createTitle')}</ModalTitle>
          {group ? null : <ModalDescription>{t('createDescription')}</ModalDescription>}
        </ModalHeader>
        <ModalBody className="space-y-2">
          <Input
            autoFocus
            value={value}
            maxLength={GROUP_NAME_MAX}
            placeholder={t('namePlaceholder')}
            aria-label={t('namePlaceholder')}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {problem ? (
            <p className="text-destructive text-xs" role="alert">
              {problem}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
          <Button size="sm" className="w-full sm:w-auto" onClick={() => void submit()} disabled={!name || unchanged || pending}>
            {pending ? <Loading className="size-4 shrink-0" /> : null}
            {group ? t('save') : t('create')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

interface SessionGroupSectionsProps {
  projectId: string;
  groups: readonly ProjectSessionGroup[];
  /** The Labels facet, sent to every group's list like the main list's. */
  labels: string[] | undefined;
  collapsedSectionIds: ReadonlySet<string>;
  onToggleSection: (sectionId: string) => void;
  /** The status and source facets, applied to each group's rows. */
  passesFacets: (session: ProjectSession) => boolean;
  renderNode: (session: ProjectSession) => ReactNode;
  actions: ReturnType<typeof useSessionGroupActions>;
  onRename: (group: ProjectSessionGroup) => void;
}

/** Every group of the project, in order. */
export function SessionGroupSections({ groups, ...rest }: SessionGroupSectionsProps) {
  const groupIds = groups.map((group) => group.group_id);
  return (
    <>
      {groups.map((group) => (
        <SessionGroupSection key={group.group_id} group={group} groupIds={groupIds} {...rest} />
      ))}
    </>
  );
}

function SessionGroupSection({
  projectId,
  group,
  groupIds,
  labels,
  collapsedSectionIds,
  onToggleSection,
  passesFacets,
  renderNode,
  actions,
  onRename,
}: Omit<SessionGroupSectionsProps, 'groups'> & { group: ProjectSessionGroup; groupIds: string[] }) {
  const t = useTranslations('sidebar');
  const tGroups = useTranslations('sidebar.sessionGroups');
  const sectionId = sessionGroupSectionId(group.group_id);
  const open = !collapsedSectionIds.has(sectionId);
  // Any starter and any depth, like Pinned: a session is in a group because
  // someone put it there. Loaded only while the group is open.
  const query = useProjectSessions(projectId, {
    group: group.group_id,
    labels,
    limit: SIDEBAR_PAGE_SIZE,
    enabled: open,
    refetchOnWindowFocus: true,
  });
  // A pinned row shows under Pinned only. The `group_id` check drops a row the
  // viewer just moved out, before the refetch lands.
  const rows = query.sessions.filter(
    (session) => session.group_id === group.group_id && !session.pinned_at && passesFacets(session),
  );
  const index = groupIds.indexOf(group.group_id);
  const drop = useDropTarget({
    onDropSession: (sessionId) => void actions.move(sessionId, group.group_id),
    onDropGroup: (groupId) => void actions.reorder(moveGroupTo(groupIds, groupId, index)),
  });

  return (
    <div {...drop.props} data-session-group={group.group_id}>
      <Disclosure
        open={open}
        onOpenChange={() => onToggleSection(sectionId)}
        className="group/section space-y-1"
        transition={{ duration: 0.15, ease: 'easeOut' }}
      >
        <DisclosureTrigger>
          <div
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(GROUP_DRAG_TYPE, group.group_id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            className={cn(
              'group/section-header text-muted-foreground relative flex items-center gap-1 rounded-md px-2 text-sm font-medium',
              SESSION_ROW_HEIGHT_CLASS,
              drop.over === 'session' && 'bg-sidebar-row text-sidebar-foreground',
              // A group dropped here takes this place: a line marks it.
              drop.over === 'group' && 'before:bg-foreground/40 before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded-full',
            )}
          >
            <FolderSimpleIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{group.name}</span>
            <CaretRightIcon
              aria-hidden
              className="duration-normal size-3 shrink-0 opacity-0 transition-transform ease-out group-hover/section-header:opacity-100 group-data-[state=open]/section:rotate-90"
            />
            <SessionGroupMenu
              group={group}
              onRename={() => onRename(group)}
              onMoveUp={moveGroupBy(groupIds, group.group_id, -1)}
              onMoveDown={moveGroupBy(groupIds, group.group_id, 1)}
              onReorder={(ids) => void actions.reorder(ids)}
              projectId={projectId}
            />
          </div>
        </DisclosureTrigger>
        <DisclosureContent contentClassName="space-y-px">
          {rows.map(renderNode)}
          {query.data !== undefined && rows.length === 0 && !query.hasNextPage ? (
            <p className="text-muted-foreground px-2 py-1 text-xs">{tGroups('empty')}</p>
          ) : null}
          {query.hasNextPage && (
            <ShowMoreButton
              loading={query.isFetchingNextPage}
              failed={query.isFetchNextPageError}
              label={t('loadMore')}
              onClick={() => query.fetchNextPage()}
            />
          )}
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}

/**
 * The group header's `⋯`: Rename, Move up, Move down, Delete. Hover-revealed
 * like a section header's; click and Enter/Space stop propagation so opening
 * it never toggles the group.
 */
function SessionGroupMenu({
  projectId,
  group,
  onRename,
  onMoveUp,
  onMoveDown,
  onReorder,
}: {
  projectId: string;
  group: ProjectSessionGroup;
  onRename: () => void;
  /** The order after Move up / Move down; null at that end (the item is disabled). */
  onMoveUp: string[] | null;
  onMoveDown: string[] | null;
  onReorder: (groupIds: string[]) => void;
}) {
  const tGroups = useTranslations('sidebar.sessionGroups');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useDeleteProjectSessionGroup(projectId);
  const afterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(fn);
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={`${tGroups('groupOptions')}: ${group.name}`}
            className={cn(
              SESSION_MENU_TRIGGER_CLASS,
              'relative ml-auto opacity-0',
              'before:absolute before:-inset-1',
              'group-hover/section-header:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            )}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
            }}
          >
            <DotsThreeIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="w-44">
          <DropdownMenuItem className="cursor-pointer" onSelect={() => afterClose(onRename)}>
            <PencilSimpleIcon />
            {tGroups('rename')}
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer" disabled={!onMoveUp} onSelect={() => onMoveUp && onReorder(onMoveUp)}>
            <ArrowUpIcon />
            {tGroups('moveUp')}
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer" disabled={!onMoveDown} onSelect={() => onMoveDown && onReorder(onMoveDown)}>
            <ArrowDownIcon />
            {tGroups('moveDown')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            variant="destructive"
            onSelect={() => afterClose(() => setConfirmOpen(true))}
          >
            <TrashIcon />
            {tGroups('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={tGroups('deleteTitle')}
        description={tGroups('deleteDescription', { name: group.name })}
        confirmLabel={tGroups('delete')}
        cancelLabel={tGroups('cancel')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(group.group_id, {
            onSuccess: () => {
              setConfirmOpen(false);
              successToast(tGroups('deleted'));
            },
            onError: () => errorToast(tGroups('deleteFailed')),
          })
        }
      />
    </>
  );
}

/**
 * The rest of the list as a drop target: a session row dropped here leaves
 * its group. Highlights only while a row is over it.
 */
export function UngroupDropArea({
  onDropSession,
  children,
}: {
  onDropSession: (sessionId: string) => void;
  children: ReactNode;
}) {
  const drop = useDropTarget({ onDropSession });
  return (
    <div {...drop.props} className={cn('space-y-px rounded-md', drop.over === 'session' && 'bg-sidebar-row/50')}>
      {children}
    </div>
  );
}
