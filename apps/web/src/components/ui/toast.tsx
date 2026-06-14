import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import * as React from 'react';
import { GoCheckCircleFill } from 'react-icons/go';
import { HiOutlineExclamationCircle, HiOutlineXCircle } from 'react-icons/hi';
import { toast } from 'sonner';

type ToastOptions = {
  description?: string;
  duration?: number;
  id?: string | number;
  position?:
    | 'bottom-right'
    | 'bottom-left'
    | 'top-right'
    | 'top-left'
    | 'top-center'
    | 'bottom-center';
  button?: React.ReactNode;
};

type LoadingToastOptions<T = unknown> = ToastOptions & {
  success?: string | ((data: T) => string);
  error?: string | ((error: unknown) => string);
  showErrorToast?: boolean;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An error occurred';
};

const DEFAULT_DURATION = 3000;
const DEFAULT_POSITION = 'bottom-right';

const toastRowAlign = (options?: Pick<ToastOptions, 'description' | 'button'>) =>
  options?.description || options?.button ? 'items-start mt-0.5' : 'items-center';

function ToastMessage({
  message,
  description,
  button,
}: {
  message: string;
  description?: string;
  button?: React.ReactNode;
}) {
  return (
    <div className="flex grow flex-col items-start gap-2">
      <div className="flex flex-col items-start gap-1">
        <h2 className="text-sm font-medium">{message}</h2>
        {description && <p className="text-sm font-medium">{description}</p>}
      </div>
      {button && <div className="self-stretch sm:self-start">{button}</div>}
    </div>
  );
}

export const successToast = (message: string, options?: ToastOptions) => {
  const isMobile = window.innerWidth <= 768;

  toast.custom(
    (t) => (
      <div className="border-primary/10 bg-background text-foreground w-full rounded-[0.64rem] border px-4 py-3 shadow-lg sm:w-[var(--width)]">
        <div className={cn('flex gap-2', toastRowAlign(options))}>
          <div className={cn('flex grow gap-3', toastRowAlign(options))}>
            <GoCheckCircleFill className="text-kortix-green size-5 shrink-0" />

            <ToastMessage
              message={message}
              description={options?.description}
              button={options?.button}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-primary size-7 shrink-0 cursor-auto p-0"
            onClick={() => toast.dismiss(t)}
            aria-label="Close notification"
          >
            <Icon.Close size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    ),
    {
      id: options?.id,
      duration: options?.duration || DEFAULT_DURATION,
      position: isMobile ? 'top-center' : options?.position || DEFAULT_POSITION,
    },
  );
};

/** Show or update a loading toast; pass `id` to update an existing toast in place. */
export const progressToast = (message: string, options?: ToastOptions): string | number => {
  const isMobile = window.innerWidth <= 768;

  return toast.custom(
    (t) => (
      <div className="border-primary/10 bg-background text-foreground w-full rounded-[0.64rem] border px-4 py-3 shadow-lg sm:w-[var(--width)]">
        <div className={cn('flex gap-2', toastRowAlign(options))}>
          <div className={cn('flex grow gap-3', toastRowAlign(options))}>
            <Loading className="text-primary size-4 shrink-0 animate-spin" />
            <ToastMessage
              message={message}
              description={options?.description}
              button={options?.button}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-primary size-7 shrink-0 cursor-auto p-0"
            onClick={() => toast.dismiss(t)}
            aria-label="Close notification"
          >
            <Icon.Close size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    ),
    {
      id: options?.id,
      duration: options?.duration ?? Infinity,
      position: isMobile ? 'top-center' : options?.position || DEFAULT_POSITION,
    },
  );
};

export const loadingToast = <T,>(
  message: string,
  promiseInput: Promise<T> | (() => Promise<T>),
  options?: LoadingToastOptions<T>,
): Promise<T> => {
  const isMobile = window.innerWidth <= 768;
  const promise = typeof promiseInput === 'function' ? promiseInput() : promiseInput;

  const toastId = toast.custom(
    (t) => (
      <div className="border-primary/10 bg-background text-foreground w-full rounded-[0.64rem] border px-4 py-3 shadow-lg sm:w-[var(--width)]">
        <div className={cn('flex gap-2', toastRowAlign(options))}>
          <div className={cn('flex grow gap-3', toastRowAlign(options))}>
            <Loading className="text-primary size-4 shrink-0 animate-spin" />
            <ToastMessage
              message={message}
              description={options?.description}
              button={options?.button}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-primary size-7 shrink-0 cursor-auto p-0"
            onClick={() => toast.dismiss(t)}
            aria-label="Close notification"
          >
            <Icon.Close size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    ),
    {
      duration: Infinity,
      position: isMobile ? 'top-center' : options?.position || DEFAULT_POSITION,
    },
  );

  return promise.then(
    (data) => {
      toast.dismiss(toastId);
      const successMessage =
        typeof options?.success === 'function'
          ? options.success(data)
          : (options?.success ?? 'Completed');
      successToast(successMessage, options);
      return data;
    },
    (error) => {
      toast.dismiss(toastId);
      if (options?.showErrorToast) {
        const errorMessage =
          typeof options?.error === 'function'
            ? options.error(error)
            : (options?.error ?? getErrorMessage(error));
        errorToast(errorMessage, options);
      }
      throw error;
    },
  );
};

export const errorToast = (message: string, options?: ToastOptions) => {
  const isMobile = window.innerWidth <= 768;

  toast.custom(
    (t) => (
      <div
        className={cn(
          'border-primary/10 bg-background text-foreground w-full rounded-[0.64rem] border px-4 py-3 shadow-lg sm:w-[var(--width)]',
        )}
      >
        <div className={cn('flex gap-2', toastRowAlign(options))}>
          <div className={cn('flex grow gap-3', toastRowAlign(options))}>
            <HiOutlineXCircle className="text-kortix-red size-6 shrink-0" />

            <ToastMessage
              message={message}
              description={options?.description}
              button={options?.button}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-primary size-7 shrink-0 cursor-auto p-0"
            onClick={() => toast.dismiss(t)}
            aria-label="Close notification"
          >
            <Icon.Close size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    ),
    {
      id: options?.id,
      duration: options?.duration || DEFAULT_DURATION,
      position: isMobile ? 'top-center' : options?.position || DEFAULT_POSITION,
    },
  );
};

export const infoToast = (message: string, options?: ToastOptions) => {
  const isMobile = window.innerWidth <= 768;

  toast.custom(
    (t) => (
      <div className="border-primary/10 bg-background text-foreground w-full rounded-[0.64rem] border px-4 py-3 shadow-lg sm:w-[var(--width)]">
        <div className={cn('flex gap-2', toastRowAlign(options))}>
          <div className={cn('flex grow gap-3', toastRowAlign(options))}>
            <HiOutlineExclamationCircle className="text-kortix-blue size-6 shrink-0" />

            <ToastMessage
              message={message}
              description={options?.description}
              button={options?.button}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-primary size-7 shrink-0 cursor-auto p-0"
            onClick={() => toast.dismiss(t)}
            aria-label="Close notification"
          >
            <Icon.Close size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    ),
    {
      duration: options?.duration || DEFAULT_DURATION,
      position: isMobile ? 'top-center' : options?.position || DEFAULT_POSITION,
    },
  );
};

export const warningToast = (message: string, options?: ToastOptions) => {
  const isMobile = window.innerWidth <= 768;

  toast.custom(
    (t) => (
      <div className="border-primary/10 bg-background text-foreground w-full rounded-[0.64rem] border px-4 py-3 shadow-lg sm:w-[var(--width)]">
        <div className={cn('flex gap-2', toastRowAlign(options))}>
          <div className={cn('flex grow gap-3', toastRowAlign(options))}>
            <HiOutlineExclamationCircle className="text-kortix-yellow size-6 shrink-0" />

            <ToastMessage
              message={message}
              description={options?.description}
              button={options?.button}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-primary size-7 shrink-0 cursor-auto p-0"
            onClick={() => toast.dismiss(t)}
            aria-label="Close notification"
          >
            <Icon.Close size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    ),
    {
      duration: options?.duration || DEFAULT_DURATION,
      position: isMobile ? 'top-center' : options?.position || DEFAULT_POSITION,
    },
  );
};
