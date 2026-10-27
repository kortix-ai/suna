'use client';

/**
 * The account hub's one split sheet. Any pane can open a form beside itself —
 * Members "Invite", API "New token" and "Register app", project "Grant
 * access" — and the pane narrows to make room instead of a modal covering it.
 *
 * Mounted once by `AccountSettingsShell` around the content column, so the
 * sheet is a sibling column of the whole pane, not a child of its scroll.
 *
 * ```tsx
 * const sheet = useAccountHubSheet();
 * sheet.open({ title: 'New token', body: <TokenForm onDone={sheet.close} /> });
 * ```
 *
 * `body` renders inside `SplitSheetBody` (it scrolls), `footer` inside
 * `SplitSheetFooter` (it stays put). The content is a snapshot: call `open`
 * again to replace it. A form that keeps its own state across body and
 * footer (`AccessDialog`) goes in `body` alone and draws its own sticky
 * footer: it reads `useInAccountHubSheetBody()`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { SelectionBar } from '../selection/selection-bar';

import {
  SplitSheet,
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
} from '../../primitives/split-sheet';

export interface AccountHubSheetContent {
  title: ReactNode;
  description?: ReactNode;
  body: ReactNode;
  footer?: ReactNode;
}

export interface AccountHubSheet {
  open: (content: AccountHubSheetContent) => void;
  close: () => void;
}

const AccountHubSheetContext = createContext<AccountHubSheet | null>(null);
const SheetBodyContext = createContext(false);
const BottomBarSlotContext = createContext<HTMLElement | null>(null);

/**
 * A pane's bulk-action bar: the shared `SelectionBar`, pinned to the bottom of
 * the hub's page column. The column scrolls, so `sticky` would stop under a
 * short list: this renders into a slot that overlays the column's bottom edge
 * and never scrolls. Render it only while something is selected.
 */
export function AccountHubSelectionBar(props: ComponentProps<typeof SelectionBar>) {
  const slot = useContext(BottomBarSlotContext);
  if (!slot) return null;
  return createPortal(
    <div className="pointer-events-auto w-full max-w-xl">
      <SelectionBar {...props} />
    </div>,
    slot,
  );
}

/** True inside the hub sheet's body: a form there draws the sheet layout, not a modal. */
export function useInAccountHubSheetBody(): boolean {
  return useContext(SheetBodyContext);
}

/** Opens and closes the hub's split sheet. Throws outside the hub shell. */
export function useAccountHubSheet(): AccountHubSheet {
  const sheet = useContext(AccountHubSheetContext);
  if (!sheet) throw new Error('useAccountHubSheet must be used inside AccountHubSheetProvider.');
  return sheet;
}

/** Wraps the hub's content column. Its parent must have a bounded height. */
export function AccountHubSheetProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<AccountHubSheetContent | null>(null);
  const close = useCallback(() => setContent(null), []);
  const sheet = useMemo<AccountHubSheet>(() => ({ open: setContent, close }), [close]);
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);

  return (
    <AccountHubSheetContext.Provider value={sheet}>
      <BottomBarSlotContext.Provider value={barSlot}>
      <SplitSheet
        open={content !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        size="md"
      >
        <SplitSheetMain>{children}</SplitSheetMain>
        {/* `AccountHubSelectionBar`'s slot: the page column's cell again, its
            bottom edge. It takes no clicks of its own and never scrolls. */}
        <div
          ref={setBarSlot}
          className="pointer-events-none z-10 col-start-1 row-start-1 flex justify-center self-end px-4 pb-4 empty:hidden"
        />
        {content ? (
          <SplitSheetContent>
            <SplitSheetHeader>
              <SplitSheetTitle>{content.title}</SplitSheetTitle>
              {content.description ? (
                <SplitSheetDescription>{content.description}</SplitSheetDescription>
              ) : null}
            </SplitSheetHeader>
            <SplitSheetBody>
              <SheetBodyContext.Provider value>{content.body}</SheetBodyContext.Provider>
            </SplitSheetBody>
            {content.footer ? <SplitSheetFooter>{content.footer}</SplitSheetFooter> : null}
          </SplitSheetContent>
        ) : null}
      </SplitSheet>
      </BottomBarSlotContext.Provider>
    </AccountHubSheetContext.Provider>
  );
}
