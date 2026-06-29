import { useCallback, useState } from 'react';

import { errorToast, successToast } from '@/components/ui/toast';

const DEFAULT_DURATION = 1500;
const DEFAULT_SUCCESS_MESSAGE = 'Copied to clipboard';
const DEFAULT_ERROR_MESSAGE = 'Failed to copy to clipboard';

export type UseCopyOptions = {
  duration?: number;
  successMessage?: string;
  errorMessage?: string;
  toast?: boolean;
};

function resolveOptions(options?: UseCopyOptions | number) {
  const config = typeof options === 'number' ? { duration: options } : (options ?? {});

  return {
    duration: config.duration ?? DEFAULT_DURATION,
    successMessage: config.successMessage ?? DEFAULT_SUCCESS_MESSAGE,
    errorMessage: config.errorMessage ?? DEFAULT_ERROR_MESSAGE,
    toast: config.toast ?? true,
  };
}

export function useCopy(options?: UseCopyOptions | number) {
  const { duration, successMessage, errorMessage, toast: showToast } = resolveOptions(options);
  const [copied, setCopied] = useState<boolean>(false);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), duration);
        if (showToast) successToast(successMessage);
        return true;
      } catch (err) {
        console.error('Failed to copy text: ', err);
        if (showToast) errorToast(errorMessage);
        return false;
      }
    },
    [duration, errorMessage, showToast, successMessage],
  );

  return {
    copied,
    copy,
  };
}
