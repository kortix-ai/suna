import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@kortix/ui';

export function UseCaseMdxImage({
  src,
  alt = '',
  loading = 'lazy',
  className,
  ...props
}: ComponentPropsWithoutRef<'img'>) {
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
          'outline-foreground/10 h-auto max-w-full outline outline-1 -outline-offset-1',
          className,
        )}
      />
    </span>
  );
}
