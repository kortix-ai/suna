'use client';

import Image from 'next/image';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

interface AdenticLogoProps {
  size?: number;
}
export function AdenticLogo({ size = 24 }: AdenticLogoProps) {
  const { theme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // After mount, we can access the theme
  useEffect(() => {
    setMounted(true);
  }, []);

  // Use AVIF icon for small logo instances
  return (
    <Image
      src="/adentic-icon.avif"
      alt="Adentic"
      width={size}
      height={size}
      className="object-contain"
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size
      }}
    />
  );
}
