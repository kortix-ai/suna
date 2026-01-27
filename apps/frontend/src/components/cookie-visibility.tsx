'use client';

import { usePathname } from 'next/navigation';

export function CookieVisibility() {
  const pathname = usePathname();

  // Only show cookie button on homepage and dashboard
  const showOnPaths = ['/', '/dashboard'];
  const shouldShow = showOnPaths.some(path => pathname === path);

  if (shouldShow) return null;

  return (
    <style jsx global>{`
      .cky-btn-revisit-wrapper {
        display: none !important;
      }
    `}</style>
  );
}
