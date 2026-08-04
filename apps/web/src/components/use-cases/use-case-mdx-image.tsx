import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function UseCaseMdxImage({
  src,
  alt = '',
  loading = 'lazy',
  className,
  ...props
}: ComponentProps<'img'>) {
  if (!src || typeof src !== 'string') return null;

  return (
    <span className="my-5 block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        {...props}
        src={src}
        alt={alt}
        loading={loading}
        className={cn(
          'h-auto max-w-full rounded-lg outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10',
          className,
        )}
      />
    </span>
  );
}
