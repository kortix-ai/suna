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
 * footer (`AccessDialog presentation="split-sheet"`) goes in `body` alone and
 * draws its own sticky footer.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

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

  return (
    <AccountHubSheetContext.Provider value={sheet}>
      <SplitSheet
        open={content !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        size="md"
      >
        <SplitSheetMain>{children}</SplitSheetMain>
        {content ? (
          <SplitSheetContent>
            <SplitSheetHeader>
              <SplitSheetTitle>{content.title}</SplitSheetTitle>
              {content.description ? (
                <SplitSheetDescription>{content.description}</SplitSheetDescription>
              ) : null}
            </SplitSheetHeader>
            <SplitSheetBody>{content.body}</SplitSheetBody>
            {content.footer ? <SplitSheetFooter>{content.footer}</SplitSheetFooter> : null}
          </SplitSheetContent>
        ) : null}
      </SplitSheet>
    </AccountHubSheetContext.Provider>
  );
}
