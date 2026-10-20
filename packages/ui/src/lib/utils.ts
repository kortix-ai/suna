import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** The theme's named duration steps (theme.css), so `cn('duration-moderate', 'duration-300')` keeps the last one. */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { duration: [{ duration: ['fast', 'normal', 'moderate', 'slow', 'slower'] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
