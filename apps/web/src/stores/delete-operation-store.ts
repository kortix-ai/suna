import { useEffect } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

type DeleteOperationState = 'none' | 'pending' | 'success' | 'error';

interface DeleteOperationStore {
  isDeleting: boolean;
  targetId: string | null;
  isActive: boolean;
  operation: DeleteOperationState;
  isOperationInProgress: boolean;

  // Actions
  startDelete: (id: string, isActive: boolean) => void;
  setDeleteSuccess: () => void;
  setDeleteError: () => void;
  reset: () => void;
  setOperationInProgress: (inProgress: boolean) => void;

  // Complex operation
  performDelete: (
    id: string,
    isActive: boolean,
    deleteFunction: () => Promise<void>,
    onComplete?: () => void,
  ) => Promise<void>;
}

export const useDeleteOperationStore = create<DeleteOperationStore>()(
  devtools(
    (set, get) => ({
      isDeleting: false,
      targetId: null,
      isActive: false,
      operation: 'none',
      isOperationInProgress: false,

      startDelete: (id: string, isActive: boolean) => {
        set({
          isDeleting: true,
          targetId: id,
          isActive,
          operation: 'pending',
        });
      },

      setDeleteSuccess: () => {
        set({ operation: 'success' });
      },

      setDeleteError: () => {
        set({
          isDeleting: false,
          operation: 'error',
        });
      },

      reset: () => {
        set({
          isDeleting: false,
          targetId: null,
          isActive: false,
          operation: 'none',
          isOperationInProgress: false,
        });
      },

      setOperationInProgress: (inProgress: boolean) => {
        set({ isOperationInProgress: inProgress });
      },

      performDelete: async (
        id: string,
        isActive: boolean,
        deleteFunction: () => Promise<void>,
        onComplete?: () => void,
      ) => {
        // Prevent multiple operations
        if (get().isOperationInProgress) return;
        set({ isOperationInProgress: true });

        // Disable pointer events during operation
        document.body.style.pointerEvents = 'none';

        // Disable sidebar menu interactions
        const sidebarMenu = document.querySelector('.sidebar-menu');
        if (sidebarMenu) {
          sidebarMenu.classList.add('pointer-events-none');
        }

        get().startDelete(id, isActive);

        try {
          // Execute the delete operation
          await deleteFunction();

          // Use precise timing for UI updates
          setTimeout(() => {
            get().setDeleteSuccess();

            // For non-active threads, restore interaction with delay
            if (!isActive) {
              setTimeout(() => {
                document.body.style.pointerEvents = 'auto';

                if (sidebarMenu) {
                  sidebarMenu.classList.remove('pointer-events-none');
                }

                // Call the completion callback
                if (onComplete) onComplete();
              }, 100);
            }
          }, 50);
        } catch (error) {
          console.error('Delete operation failed:', error);

          // Reset states on error
          document.body.style.pointerEvents = 'auto';
          set({ isOperationInProgress: false });

          if (sidebarMenu) {
            sidebarMenu.classList.remove('pointer-events-none');
          }

          get().setDeleteError();

          // Call the completion callback
          if (onComplete) onComplete();
        }
      },
    }),
    {
      name: 'delete-operation-store',
    }
  )
);

// Hook for backward compatibility
export function useDeleteOperation() {
  const isDeleting = useDeleteOperationStore((s) => s.isDeleting);
  const targetId = useDeleteOperationStore((s) => s.targetId);
  const isActive = useDeleteOperationStore((s) => s.isActive);
  const operation = useDeleteOperationStore((s) => s.operation);
  const startDelete = useDeleteOperationStore((s) => s.startDelete);
  const setDeleteSuccess = useDeleteOperationStore((s) => s.setDeleteSuccess);
  const setDeleteError = useDeleteOperationStore((s) => s.setDeleteError);
  const resetStore = useDeleteOperationStore((s) => s.reset);
  const performDelete = useDeleteOperationStore((s) => s.performDelete);
  const isOperationInProgress = useDeleteOperationStore((s) => s.isOperationInProgress);
  const store = {
    isDeleting,
    targetId,
    isActive,
    operation,
    startDelete,
    setDeleteSuccess,
    setDeleteError,
    reset: resetStore,
    performDelete,
    isOperationInProgress,
  };

  return {
    state: {
      isDeleting: store.isDeleting,
      targetId: store.targetId,
      isActive: store.isActive,
      operation: store.operation,
    },
    dispatch: (action: { type: string; id?: string; isActive?: boolean }) => {
      switch (action.type) {
        case 'START_DELETE':
          if (action.id !== undefined && action.isActive !== undefined) {
            store.startDelete(action.id, action.isActive);
          }
          break;
        case 'DELETE_SUCCESS':
          store.setDeleteSuccess();
          break;
        case 'DELETE_ERROR':
          store.setDeleteError();
          break;
        case 'RESET':
          store.reset();
          break;
      }
    },
    performDelete: store.performDelete,
    isOperationInProgress: { current: store.isOperationInProgress },
  };
}

// Hook to handle side effects (auto-reset)
//
// It used to also navigate: on `operation === 'success' && isActive` it wrote
// `window.location.pathname = '/dashboard'`. That was a document load onto a
// route this app does not have — `/dashboard` is not in src/app. Nothing sets
// `operation` to 'success' either: `useDeleteOperationStore` and
// `useDeleteOperation` have no consumer, so `performDelete` never runs. The
// navigation was dead code pointing at a 404, so it is gone rather than
// repointed — a global "go somewhere" effect needs an owner that asks for it.
export function useDeleteOperationEffects() {
  const operation = useDeleteOperationStore((s) => s.operation);
  const isActive = useDeleteOperationStore((s) => s.isActive);
  const reset = useDeleteOperationStore((s) => s.reset);

  useEffect(() => {
    if (operation === 'success' && !isActive) {
      const timer = setTimeout(() => {
        reset();
        // Ensure pointer events are restored
        document.body.style.pointerEvents = 'auto';

        // Restore sidebar menu interactivity
        const sidebarMenu = document.querySelector('.sidebar-menu');
        if (sidebarMenu) {
          sidebarMenu.classList.remove('pointer-events-none');
        }
      }, 1000);
      return () => clearTimeout(timer);
    }

    if (operation === 'error') {
      // Reset on error immediately
      document.body.style.pointerEvents = 'auto';

      // Restore sidebar menu interactivity
      const sidebarMenu = document.querySelector('.sidebar-menu');
      if (sidebarMenu) {
        sidebarMenu.classList.remove('pointer-events-none');
      }
    }
  }, [operation, isActive, reset]);
}
