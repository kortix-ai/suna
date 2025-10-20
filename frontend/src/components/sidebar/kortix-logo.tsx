'use client';

import Image from 'next/image';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { isLocalMode, isStagingMode } from '@/lib/config';

interface KortixLogoProps {
  size?: number;
}
export function KortixLogo({ size = 24 }: KortixLogoProps) {
  const { theme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // After mount, we can access the theme
  useEffect(() => {
    setMounted(true);
  }, []);

  const shouldInvert = mounted && (
    theme === 'dark' || (theme === 'system' && systemTheme === 'dark')
  );

  return (
    <Image
      src="/kortix-symbol.svgb"
      alt="Kortix"
      width={size}
      height={size}
      className={`${shouldInvert ? 'invert' : ''} flex-shrink-0`}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    />
  );
}
