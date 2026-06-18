'use client';

import * as React from 'react';
import { useIsMobile } from '@/hooks/utils';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';

const SIDEBAR_RIGHT_COOKIE_NAME = 'sidebar_right_state';
const SIDEBAR_RIGHT_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_RIGHT_WIDTH = '280px';
const SIDEBAR_RIGHT_WIDTH_ICON = '3.25rem';

type RightSidebarContextProps = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const RightSidebarContext =
  React.createContext<RightSidebarContextProps | null>(null);

export function useRightSidebar() {
  const context = React.useContext(RightSidebarContext);
  if (!context) {
    throw new Error(
      'useRightSidebar must be used within a RightSidebarProvider.',
    );
  }
  return context;
}

/**
 * Try to use the right sidebar context, returning null if not inside the provider.
 * Useful for components that may or may not be inside the right sidebar provider.
 */
export function useRightSidebarSafe(): RightSidebarContextProps | null {
  return React.useContext(RightSidebarContext);
}

export function RightSidebarProvider({
  defaultOpen = false,
  children,
}: {
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const isMobile = useIsMobile();
  const { isOpen: isDocumentModalOpen } = useDocumentModalStore();
  const [open, _setOpen] = React.useState(defaultOpen);
  const [openMobile, setOpenMobile] = React.useState(false);

  const setOpen = React.useCallback((value: boolean) => {
    _setOpen(value);
    document.cookie = `${SIDEBAR_RIGHT_COOKIE_NAME}=${value}; path=/; max-age=${SIDEBAR_RIGHT_COOKIE_MAX_AGE}`;
  }, []);

  const toggleSidebar = React.useCallback(() => {
    setOpen(!open);
  }, [open, setOpen]);

  // Keyboard shortcut: Cmd+Shift+B (works globally, even when typing)
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      if (
        event.key === 'b' &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar, isDocumentModalOpen]);

  // Listen for left sidebar expansion → collapse right
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.expanded && open) {
        setOpen(false);
      }
    };
    window.addEventListener('sidebar-left-toggled', handler);
    return () => window.removeEventListener('sidebar-left-toggled', handler);
  }, [open, setOpen]);

  // When right sidebar expands, fire event so left sidebar can collapse
  React.useEffect(() => {
    if (open) {
      window.dispatchEvent(
        new CustomEvent('sidebar-right-toggled', {
          detail: { expanded: true },
        }),
      );
    }
  }, [open]);

  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<RightSidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, openMobile, setOpenMobile, isMobile, toggleSidebar],
  );

  return (
    <RightSidebarContext.Provider value={contextValue}>
      <div
        data-right-sidebar-state={state}
        style={
          {
            '--sidebar-right-width': SIDEBAR_RIGHT_WIDTH,
            '--sidebar-right-width-icon': SIDEBAR_RIGHT_WIDTH_ICON,
          } as React.CSSProperties
        }
        className="flex flex-1 min-h-0 overflow-hidden"
      >
        {children}
      </div>
    </RightSidebarContext.Provider>
  );
}

export { SIDEBAR_RIGHT_WIDTH, SIDEBAR_RIGHT_WIDTH_ICON };
