import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
} from 'react';

type DeleteState = {
  isDeleting: boolean;
  targetId: string | null;
  isActive: boolean;
  operation: 'none' | 'pending' | 'success' | 'error';
};

type DeleteAction =
  | { type: 'START_DELETE'; id: string; isActive: boolean }
  | { type: 'DELETE_SUCCESS' }
  | { type: 'DELETE_ERROR' }
  | { type: 'RESET' };

const initialState: DeleteState = {
  isDeleting: false,
  targetId: null,
  isActive: false,
  operation: 'none',
};

function deleteReducer(state: DeleteState, action: DeleteAction): DeleteState {
  switch (action.type) {
    case 'START_DELETE':
      return {
        ...state,
        isDeleting: true,
        targetId: action.id,
        isActive: action.isActive,
        operation: 'pending',
      };
    case 'DELETE_SUCCESS':
      return {
        ...state,
        operation: 'success',
      };
    case 'DELETE_ERROR':
      return {
        ...state,
        isDeleting: false,
        operation: 'error',
      };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

type DeleteOperationContextType = {
  state: DeleteState;
  dispatch: React.Dispatch<DeleteAction>;
  performDelete: (
    id: string,
    isActive: boolean,
    deleteFunction: () => Promise<void>,
    onComplete?: () => void,
  ) => Promise<void>;
  isOperationInProgress: React.MutableRefObject<boolean>;
};

const DeleteOperationContext = createContext<
  DeleteOperationContextType | undefined
>(undefined);

export function DeleteOperationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(deleteReducer, initialState);
  const isOperationInProgress = useRef(false);

  // Listen for state changes to handle navigation
  useEffect(() => {
    if (state.operation === 'success' && state.isActive) {
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
  }, [state.operation, state.isActive]);

  // Auto-reset after operations complete
  useEffect(() => {
    if (state.operation === 'success' && !state.isActive) {
      const timer = setTimeout(() => {
        dispatch({ type: 'RESET' });
        // Ensure pointer events are restored
        document.body.style.pointerEvents = 'auto';
        isOperationInProgress.current = false;

        // Restore sidebar menu interactivity
        const sidebarMenu = document.querySelector('.sidebar-menu');
        if (sidebarMenu) {
          sidebarMenu.classList.remove('pointer-events-none');
        }
      }, 1000);
      return () => clearTimeout(timer);
    }

    if (state.operation === 'error') {
      // Reset on error immediately
      document.body.style.pointerEvents = 'auto';
      isOperationInProgress.current = false;

      // Restore sidebar menu interactivity
      const sidebarMenu = document.querySelector('.sidebar-menu');
      if (sidebarMenu) {
        sidebarMenu.classList.remove('pointer-events-none');
      }
    }
  }, [state.operation, state.isActive]);

  const performDelete = async (
    id: string,
    isActive: boolean,
    deleteFunction: () => Promise<void>,
    onComplete?: () => void,
  ) => {
    // Prevent multiple operations
    if (isOperationInProgress.current) return;
    isOperationInProgress.current = true;

    // Disable pointer events during operation
    document.body.style.pointerEvents = 'none';

    // Disable sidebar menu interactions
    const sidebarMenu = document.querySelector('.sidebar-menu');
    if (sidebarMenu) {
      sidebarMenu.classList.add('pointer-events-none');
    }

    dispatch({ type: 'START_DELETE', id, isActive });

    try {
      // Execute the delete operation
      await deleteFunction();

      // Use precise timing for UI updates
      setTimeout(() => {
        dispatch({ type: 'DELETE_SUCCESS' });

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
      isOperationInProgress.current = false;

      if (sidebarMenu) {
        sidebarMenu.classList.remove('pointer-events-none');
      }

      dispatch({ type: 'DELETE_ERROR' });

      // Call the completion callback
      if (onComplete) onComplete();
    }
  };

  return (
    <DeleteOperationContext.Provider
      value={{
        state,
        dispatch,
        performDelete,
        isOperationInProgress,
      }}
    >
      {children}
    </DeleteOperationContext.Provider>
  );
}

export function useDeleteOperation() {
  const context = useContext(DeleteOperationContext);
  if (context === undefined) {
    throw new Error(
      'useDeleteOperation must be used within a DeleteOperationProvider',
    );
  }
  return context;
}
