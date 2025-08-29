'use client';

import { ThreeSpinner } from '@/components/ui/three-spinner';

interface OmniLogoProps {
  size?: number;
}

export function OmniLogo({ size = 24 }: OmniLogoProps) {
  return <ThreeSpinner size={size} color="currentColor" className="flex-shrink-0" />;
}


