export const KORTIX_BLUE_HSL = '210 93% 56.9%';

export function accentColor(): string {
  return `hsl(${KORTIX_BLUE_HSL})`;
}

export function accentSoft(isDark: boolean): string {
  return `hsl(${KORTIX_BLUE_HSL} / ${isDark ? '0.12' : '0.10'})`;
}
