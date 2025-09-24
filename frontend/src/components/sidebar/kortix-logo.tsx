'use client';

import Image from 'next/image';

interface KusorLogoProps {
  size?: number;
}
export function KortixLogo({ size = 200 }: KusorLogoProps) {
  return (
    <Image
        src="/kusor-2.png"
        alt="Kusor"
        width={size}
        height={size}
        className="flex-shrink-0"
        style={{ width: size, height: size, minWidth: size, minHeight: size }}
      />
  );
}
