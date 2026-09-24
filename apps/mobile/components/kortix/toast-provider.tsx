/**
 * Toast provider — `useToast()` returns the app's toast functions.
 *
 *   const toast = useToast();
 *   toast.success('Saved');
 *   toast.error('Unable to save. Try again.', { description, action, duration });
 *   const id = toast.loading('Uploading…');  toast.success('Uploaded', { id });
 *   await toast.promise(upload(), { loading: 'Uploading…', success: 'Uploaded', error: (e) => … });
 *   toast.dismiss(id);  toast.dismiss();  // one / all
 *
 * `sonner-native` renders them (https://sonner-native.netlify.app, Jay
 * 2026-09-22): it owns the stack, the swipe, the timers and the motion. This
 * file is the seam — the app's API and its haptics on one side, the library on
 * the other — so no screen imports the library directly and the look stays in
 * `toast.tsx`. Values and behaviour: design.md §11.
 */
import * as React from 'react';
import { Toaster, toast as sonner } from 'sonner-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToastIcons, useToastSkin } from './toast';
import { haptics } from '@/lib/haptics';
import {
  TOAST_DEFAULT_DURATION_MS,
  TOAST_GAP,
  TOAST_MAX_VISIBLE,
  toastDuration,
  toastErrorMessage,
  toastHaptic,
  toastKeepsCloseButton,
  resolveToastMessage,
  type ToastOptions,
  type ToastType,
} from '@/lib/ui/toast-model';

export type { ToastAction, ToastOptions, ToastType } from '@/lib/ui/toast-model';

type ShowToast = (message: string, options?: ToastOptions) => string;

export interface ToastPromiseMessages<T> {
  loading: string;
  success: string | ((data: T) => string);
  /** Omit to show no error toast (the promise still rejects), like web's `loadingToast`. */
  error?: string | ((error: unknown) => string);
}

export interface ToastApi {
  success: ShowToast;
  error: ShowToast;
  info: ShowToast;
  warning: ShowToast;
  /** Loader toast that stays until updated (`{ id }`) or dismissed. */
  loading: ShowToast;
  /** Loading toast that turns into the success or error toast in place. Resolves / rejects with the promise. */
  promise: <T>(
    promise: Promise<T> | (() => Promise<T>),
    messages: ToastPromiseMessages<T>,
    options?: Omit<ToastOptions, 'duration'>,
  ) => Promise<T>;
  /** Dismiss one toast, or every toast without an id. */
  dismiss: (id?: string) => void;
}

const SHOW: Record<ToastType, (message: string, data?: Record<string, unknown>) => string | number> = {
  success: (m, d) => sonner.success(m, d),
  error: (m, d) => sonner.error(m, d),
  info: (m, d) => sonner.info(m, d),
  warning: (m, d) => sonner.warning(m, d),
  loading: (m, d) => sonner.loading(m, d),
};

function show(type: ToastType, message: string, options?: ToastOptions): string {
  const duration = toastDuration(type, options?.duration);
  const buzz = toastHaptic(type);
  // An update in place (`{ id }`) is the same toast, so it does not buzz again.
  if (buzz && !options?.id) haptics[buzz]();
  const id = SHOW[type](message, {
    ...(options?.id ? { id: options.id } : null),
    ...(options?.description ? { description: options.description } : null),
    // sonner-native takes no Infinity: a toast that never leaves is one that
    // is not dismissible by a timer, so it gets the close button instead.
    ...(Number.isFinite(duration) ? { duration } : { duration: Number.MAX_SAFE_INTEGER }),
    closeButton: toastKeepsCloseButton(duration),
    ...(options?.action
      ? { action: { label: options.action.label, onClick: options.action.onPress } }
      : null),
  });
  return String(id);
}

const dismiss = (id?: string) => {
  sonner.dismiss(id);
};

const api: ToastApi = {
  success: (message, options) => show('success', message, options),
  error: (message, options) => show('error', message, options),
  info: (message, options) => show('info', message, options),
  warning: (message, options) => show('warning', message, options),
  loading: (message, options) => show('loading', message, options),
  promise: (input, messages, options) => {
    const id = show('loading', messages.loading, options);
    const promise = typeof input === 'function' ? input() : input;
    return promise.then(
      (data) => {
        show('success', resolveToastMessage(messages.success, data), { ...options, id });
        return data;
      },
      (error: unknown) => {
        if (messages.error === undefined) dismiss(id);
        else {
          const message =
            typeof messages.error === 'function' ? messages.error(error) : messages.error || toastErrorMessage(error);
          show('error', message, { ...options, id });
        }
        throw error;
      },
    );
  },
  dismiss,
};

interface ToastContextType {
  toast: ToastApi;
}

const ToastContext = React.createContext<ToastContextType | undefined>(undefined);

/** Mounts the toaster and provides `useToast()`. One per app, in `app/_layout.tsx`. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useColorScheme();
  // `offset` measures from the screen edge, not the safe area, so a toast
  // landed under the status bar / notch (Jay, 2026-09-22).
  const insets = useSafeAreaInsets();
  const icons = useToastIcons();
  const skin = useToastSkin();
  const value = React.useMemo<ToastContextType>(() => ({ toast: api }), []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster
        position="top-center"
        theme={colorScheme === 'dark' ? 'dark' : 'light'}
        duration={TOAST_DEFAULT_DURATION_MS}
        visibleToasts={TOAST_MAX_VISIBLE}
        gap={TOAST_GAP}
        offset={insets.top + TOAST_GAP}
        swipeToDismissDirection="up"
        pauseWhenPageIsHidden
        closeButton={false}
        icons={icons}
        toastOptions={{
          style: skin.toast,
          toastContentStyle: skin.toastContent,
          titleStyle: skin.title,
          descriptionStyle: skin.description,
          actionButtonStyle: skin.actionButton,
          actionButtonTextStyle: skin.actionButtonText,
          closeButtonStyle: skin.closeButton,
        }}
      />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context.toast;
}
