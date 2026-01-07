/**
 * Custom toast wrapper that suppresses success/error notifications
 * to reduce UI noise for the user.
 * 
 * All toast.success() and toast.error() calls become no-ops.
 * Other toast types (warning, info, loading, promise, custom, dismiss) still work.
 */
import { toast as sonnerToast, type ExternalToast } from 'sonner';

// Create a wrapper that no-ops success and error
export const toast = Object.assign(
  // The main toast function - keep it working for custom toasts
  (message: string | React.ReactNode, data?: ExternalToast) => sonnerToast(message, data),
  {
    // No-op for success - user doesn't need to see these
    success: (_message: string | React.ReactNode, _data?: ExternalToast) => {
      // Intentionally empty - suppress success notifications
      return '';
    },
    // No-op for error - user doesn't need to see these
    error: (_message: string | React.ReactNode, _data?: ExternalToast) => {
      // Intentionally empty - suppress error notifications
      return '';
    },
    // Keep warning - these are still useful
    warning: sonnerToast.warning,
    // Keep info - these can be useful
    info: sonnerToast.info,
    // Keep loading - this is useful for async operations
    loading: sonnerToast.loading,
    // Keep promise - this is useful for async operations
    promise: sonnerToast.promise,
    // Keep custom - for any custom toast needs
    custom: sonnerToast.custom,
    // Keep message - basic toast
    message: sonnerToast.message,
    // Keep dismiss - to dismiss toasts
    dismiss: sonnerToast.dismiss,
  }
);

// Re-export everything else from sonner
export { Toaster } from 'sonner';
export type { ExternalToast, ToasterProps } from 'sonner';





