/**
 * Splits a THEME `hsl(H S% L%)` string into its numbers, as written. A leaf (no
 * expo-router import), so `bun test` runs it; `caller` names the function in the error.
 */
const HSL_PARTS = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/;

export function parseHsl(hsl: string, caller: string): { h: string; s: string; l: string } {
  const parts = HSL_PARTS.exec(hsl.trim());
  if (!parts) throw new Error(`${caller} expects a THEME 'hsl(H S% L%)' string, received: ${hsl}`);
  return { h: parts[1], s: parts[2], l: parts[3] };
}
