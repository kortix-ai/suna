import { toast as sonnerToast, type ExternalToast } from 'sonner';

export const toast = Object.assign(
  (message: string | React.ReactNode, data?: ExternalToast) => sonnerToast(message, data),
  {
    success: sonnerToast.success,
    error: sonnerToast.error,
    warning: sonnerToast.warning,
    info: sonnerToast.info,
    loading: sonnerToast.loading,
    promise: sonnerToast.promise as any,
    custom: sonnerToast.custom,
    message: sonnerToast.message,
    dismiss: sonnerToast.dismiss,
  }
);

// Re-export everything else from sonner
export { Toaster } from 'sonner';
export type { ExternalToast, ToasterProps } from 'sonner';




