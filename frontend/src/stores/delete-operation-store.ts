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
  const store = useDeleteOperationStore();
  
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

// Hook to handle side effects (navigation, auto-reset)
export function useDeleteOperationEffects() {
  const { operation, isActive, reset } = useDeleteOperationStore();
  
  useEffect(() => {
    if (operation === 'success' && isActive) {
      // Delay navigation to allow UI feedback
      const timer = setTimeout(() => {
        try {
          // Use window.location for reliable navigation
          window.location.pathname = '/dashboard';
        } catch (error) {
          console.error('Navigation error:', error);
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [operation, isActive]);
  
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

