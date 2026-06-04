/**
 * ModeLogo - Displays the Kortix Basic or Advanced SVG logo
 * 
 * Uses theme-appropriate variants (dark on light, light on dark)
 */

import React from 'react';
import { useColorScheme } from 'nativewind';

// SVG imports
import BasicDark from '@/assets/brand/Basic-Dark.svg';
import BasicLight from '@/assets/brand/Basic-Light.svg';
import AdvancedDark from '@/assets/brand/Advanced-Dark.svg';
import AdvancedLight from '@/assets/brand/Advanced-Light.svg';

interface ModeLogoProps {
  mode: 'basic' | 'advanced';
  height?: number;
}

// Aspect ratios from the actual SVG viewBox dimensions
const BASIC_ASPECT = 985 / 144; // ~6.84
const ADVANCED_ASPECT = 1395 / 143; // ~9.76

export function ModeLogo({ mode, height = 14 }: ModeLogoProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Calculate width from aspect ratio
  const aspectRatio = mode === 'advanced' ? ADVANCED_ASPECT : BASIC_ASPECT;
  const width = Math.round(height * aspectRatio);

  // Select the appropriate SVG variant
  // Light variant for dark mode, dark variant for light mode
  if (mode === 'basic') {
    const Logo = isDark ? BasicLight : BasicDark;
    return <Logo width={width} height={height} />;
  }

  const Logo = isDark ? AdvancedLight : AdvancedDark;
  return <Logo width={width} height={height} />;
}

export default ModeLogo;
