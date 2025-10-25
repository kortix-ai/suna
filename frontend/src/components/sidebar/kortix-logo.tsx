'use client';

import Image from 'next/image';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { isLocalMode, isStagingMode } from '@/lib/config';
import { cn } from '@/lib/utils';

interface KortixLogoProps {
  size?: number;
  variant?: 'symbol' | 'logomark';
  className?: string;
}
export function KortixLogo({ size = 24, variant = 'symbol', className }: KortixLogoProps) {
  const { theme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // After mount, we can access the theme
  useEffect(() => {
    setMounted(true);
  }, []);

  const shouldInvert = mounted && (
    theme === 'dark' || (theme === 'system' && systemTheme === 'dark')
  );

  // For logomark variant, use logomark-white.svg which is already white
  // and invert it for light mode instead
  if (variant === 'logomark') {
    return (
      <Image
        src="/logomark-white.svg"
        alt="Kortix"
        width={size}
        height={size}
        className={cn(`${shouldInvert ? '' : 'invert'} flex-shrink-0`, className)}
        style={{ height: size, width: 'auto' }}
      />
    );
  }

  // Default symbol variant behavior (unchanged)
  return (
    <Image
      src="/kortix-symbol.svg"
      alt="Kortix"
      width={size}
      height={size}
      className={cn(`${shouldInvert ? 'invert' : ''} flex-shrink-0`, className)}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    />
  );
}
