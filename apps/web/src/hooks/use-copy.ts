import { useState } from 'react';

export function useCopy(duration = 1500) {
  const [copied, setCopied] = useState<boolean>(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), duration);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  };

  return {
    copied,
    copy,
  };
}
