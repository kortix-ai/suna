'use client';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { useAuth } from '@/features/providers/auth-provider';
import { useNavRowMeta, type NavRowMeta } from '@/features/workspace/project-sidebar/nav-row-meta';
import { useDebounce } from '@/hooks/use-debounce';
import { useTranslations } from '@/i18n/use-translations';
import { spring } from '@/lib/springs';
import { updateProfileMetadata } from '@/lib/auth/update-profile';
import { cn } from '@/lib/utils';
import {
  SIDEBAR_NAV_METADATA_KEY,
  resolveSidebarNav,
  sidebarNavKey,
  useSidebarNavStore,
  type SidebarNavEntry,
  type SidebarNavItemId,
} from '@/stores/sidebar-nav-store';
import { DotsSixVerticalIcon } from '@phosphor-icons/react';
import { Reorder } from 'motion/react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

/**
 * "Customize sidebar": the nav rows in two groups, "Sidebar" and "More". Where a row sits is the setting: drag it across the line to
 * move it under More, drag it back to show it. Changes apply as they are
 * made; there is no save step. Opened from the sidebar's More menu and
 * the command palette through `openCustomizeSidebar()`.
 */
export function CustomizeSidebarModal({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const open = useSidebarNavStore((s) => s.customizeOpen);
  const setOpen = useSidebarNavStore((s) => s.setCustomizeOpen);
  const reset = useSidebarNavStore((s) => s.reset);
  const onOpenChange = useSidebarNavAccountSync(open, setOpen);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('customizeSidebar')}</ModalTitle>
          <ModalDescription>{t('customizeSidebarDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <NavRowGroups projectId={projectId} />
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            {t('resetSidebar')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function saveSidebarNav(items: SidebarNavEntry[]) {
  updateProfileMetadata({ [SIDEBAR_NAV_METADATA_KEY]: items }).catch((error) => {
    console.warn('[sidebar] Could not save the sidebar layout to the account:', error);
  });
}

/**
 * Keeps the layout on the account, so it survives sign-out (which sweeps
 * localStorage) and follows the person to the desktop app. The account copy
 * is applied when the user loads; an edit is saved once, when the modal
 * closes. Only an explicit close writes: the sign-out sweep also resets the
 * store, and a store subscription would save that reset over the layout.
 */
function useSidebarNavAccountSync(open: boolean, setOpen: (open: boolean) => void) {
  const { user } = useAuth();
  const userId = user?.id;
  const remote: unknown = user?.user_metadata?.[SIDEBAR_NAV_METADATA_KEY];
  const remoteKey = JSON.stringify(remote ?? null);
  const openedWith = useRef<string | null>(null);

  useEffect(() => {
    // An open modal holds edits the account does not have yet.
    if (!userId || useSidebarNavStore.getState().customizeOpen) return;
    const { items, push } = resolveSidebarNav(
      JSON.parse(remoteKey),
      useSidebarNavStore.getState().items,
    );
    useSidebarNavStore.getState().setItems(items);
    if (push) saveSidebarNav(items);
  }, [userId, remoteKey]);

  // The modal opens through the store (`openCustomizeSidebar`), so the
  // snapshot follows `open`, not `onOpenChange`.
  useEffect(() => {
    if (open) openedWith.current = sidebarNavKey(useSidebarNavStore.getState().items);
  }, [open]);

  return useCallback(
    (next: boolean) => {
      const { items } = useSidebarNavStore.getState();
      if (!next && openedWith.current !== null && openedWith.current !== sidebarNavKey(items)) {
        saveSidebarNav(items);
      }
      if (!next) openedWith.current = null;
      setOpen(next);
    },
    [setOpen],
  );
}

/** The line between the two groups. A list value like any row, so a drag
 *  across it is an ordinary reorder; it is never dragged itself. */
const DIVIDER = '__more__';
type ListValue = SidebarNavItemId | typeof DIVIDER;

const { exit: _exit, ...reorderTransition } = spring.moderate;

function NavRowGroups({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const meta = useNavRowMeta(projectId);
  const items = useSidebarNavStore((s) => s.items);
  const setItems = useSidebarNavStore((s) => s.setItems);
  const listRef = useRef<HTMLUListElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState(false);
  const hintId = useId();

  // Only the rows this project offers are listed; the rest keep their slot.
  const saved = useMemo<ListValue[]>(() => {
    const listed = items.filter((e) => meta[e.id]);
    return [
      ...listed.filter((e) => e.visibility !== 'never').map((e) => e.id),
      DIVIDER,
      ...listed.filter((e) => e.visibility === 'never').map((e) => e.id),
    ];
  }, [items, meta]);
  const savedKey = saved.join('|');

  // The drag edits a local draft, never the store. Every reorder frame used
  // to write the persisted store (a localStorage write) and re-render the
  // whole sidebar behind the modal; now a frame re-renders this list only.
  const [draft, setDraft] = useState(saved);
  const draftKey = draft.join('|');
  // Follow the store when it changes from outside (Reset). Adjusted during
  // render, React's pattern for state derived from a changed input.
  const [syncedKey, setSyncedKey] = useState(savedKey);
  if (syncedKey !== savedKey) {
    setSyncedKey(savedKey);
    if (draftKey !== savedKey) setDraft(saved);
  }

  const save = (list: ListValue[]) => {
    const split = list.indexOf(DIVIDER);
    const placed = list
      .filter((v): v is SidebarNavItemId => v !== DIVIDER)
      .map((id): SidebarNavEntry => {
        if (list.indexOf(id) > split) return { id, visibility: 'never' };
        const was = items.find((e) => e.id === id)!.visibility;
        return { id, visibility: was === 'never' ? 'always' : was };
      });
    let i = 0;
    setItems(items.map((e) => (meta[e.id] ? placed[i++] : e)));
  };

  // Save once the order settles: after the drag ends and 200ms pass without
  // a change. `settledKey === draftKey` keeps a stale debounced value from
  // writing over a draft the store just reset.
  const { debouncedValue: settled } = useDebounce(draft, 200);
  const settledKey = settled.join('|');
  useEffect(() => {
    if (dragging || settledKey !== draftKey || draftKey === savedKey) return;
    save(settled);
  });

  // Closing the modal inside the 200ms window must not drop the last move.
  const flushRef = useRef(() => {});
  useLayoutEffect(() => {
    flushRef.current = () => {
      if (draftKey !== savedKey) save(draft);
    };
  });
  useEffect(() => () => flushRef.current(), []);

  // Stable across renders so memoized rows skip re-rendering on every frame.
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  });
  const moveByKey = useCallback(
    (id: SidebarNavItemId, delta: -1 | 1) => {
      const current = draftRef.current;
      const from = current.indexOf(id);
      const to = from + delta;
      if (to < 0 || to >= current.length) return;
      const next = [...current];
      [next[from], next[to]] = [next[to], next[from]];
      setDraft(next);
      const split = next.indexOf(DIVIDER);
      const at = next.indexOf(id);
      const inSidebar = at < split;
      setAnnouncement(
        t('reorderAnnouncement', {
          name: meta[id]!.label,
          group: inSidebar ? t('inSidebar') : t('underMore'),
          position: inSidebar ? at + 1 : at - split,
          total: inSidebar ? split : next.length - split - 1,
        }),
      );
      // Reordering moves the DOM node, which can drop focus from the handle.
      requestAnimationFrame(() =>
        listRef.current?.querySelector<HTMLElement>(`[data-grip="${id}"]`)?.focus(),
      );
    },
    [t, meta],
  );

  const dividerAt = draft.indexOf(DIVIDER);
  const hiddenCount = draft.length - dividerAt - 1;

  return (
    <section className="space-y-2">
      <GroupHeading label={t('inSidebar')} count={dividerAt} />
      <p id={hintId} className="sr-only">
        {t('reorderHint')}
      </p>
      <Reorder.Group
        ref={listRef}
        as="ul"
        axis="y"
        values={draft}
        onReorder={setDraft}
        className="flex flex-col gap-px"
      >
        {draft.map((value, index) =>
          value === DIVIDER ? (
            <Reorder.Item
              key={DIVIDER}
              as="li"
              value={DIVIDER}
              dragListener={false}
              transition={reorderTransition}
              className="list-none"
            >
              {dividerAt === 0 ? <EmptyDrop label={t('sidebarEmpty')} /> : null}
              <div className="pt-4 pb-2">
                <GroupHeading label={t('underMore')} count={hiddenCount} />
              </div>
              {hiddenCount === 0 ? <EmptyDrop label={t('moreEmpty')} /> : null}
            </Reorder.Item>
          ) : (
            <NavRow
              key={value}
              id={value}
              meta={meta[value]!}
              inMore={index > dividerAt}
              first={index === 0 || draft[index - 1] === DIVIDER}
              last={index === draft.length - 1 || draft[index + 1] === DIVIDER}
              hintId={hintId}
              onMove={moveByKey}
              onDragChange={setDragging}
            />
          ),
        )}
      </Reorder.Group>
      <p className="text-muted-foreground pt-1 text-xs">{t('moreCaption')}</p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <h3 className="text-foreground flex-1 text-xs font-medium">{label}</h3>
      <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
    </div>
  );
}

function EmptyDrop({ label }: { label: string }) {
  return (
    <p className="text-muted-foreground border-muted-foreground/40 rounded-md border border-dashed px-3 py-2.5 text-xs">
      {label}
    </p>
  );
}

/**
 * One row. Same recipe as the sidebar's Connect MCP / Connect your computer
 * block: `bg-hover` rows on a 1px seam, `rounded-sm` inside, `rounded-md` on
 * the outer corners of each group's first and last row.
 */
const NavRow = memo(function NavRow({
  id,
  meta,
  inMore,
  first,
  last,
  hintId,
  onMove,
  onDragChange,
}: {
  id: SidebarNavItemId;
  meta: NavRowMeta;
  inMore: boolean;
  first: boolean;
  last: boolean;
  hintId: string;
  onMove: (id: SidebarNavItemId, delta: -1 | 1) => void;
  onDragChange: (dragging: boolean) => void;
}) {
  const t = useTranslations('sidebar');
  const [dragging, setDragging] = useState(false);

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      onMove(id, event.key === 'ArrowUp' ? -1 : 1);
    }
  };

  return (
    <Reorder.Item
      as="li"
      value={id}
      transition={reorderTransition}
      onDragStart={() => {
        setDragging(true);
        onDragChange(true);
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragChange(false);
      }}
      className={cn(
        'bg-hover relative flex h-9 cursor-move touch-none list-none items-center gap-2.5 rounded-sm px-1.5 select-none',
        first && 'rounded-t-md',
        last && 'rounded-b-md',
        dragging && 'bg-popover ring-border z-10 rounded-md shadow-sm ring-1',
      )}
    >
      <button
        data-grip={id}
        type="button"
        aria-label={t('reorderItem', { name: meta.label })}
        aria-describedby={hintId}
        onKeyDown={onHandleKeyDown}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/15 flex size-6 shrink-0 cursor-move items-center justify-center rounded-sm transition-colors focus-visible:ring-3 focus-visible:outline-none"
      >
        <DotsSixVerticalIcon className="size-4" weight="bold" />
      </button>
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center [&>svg]:size-4',
          inMore ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {meta.icon}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          inMore ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {meta.label}
      </span>
    </Reorder.Item>
  );
});
