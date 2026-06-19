// FNV-1a-ish string hash → stable 32-bit int. Same label always hashes the same,
// so an entity keeps its color across renders/sessions.
function hashLabel(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface ChalkColors {
  background: string;
  foreground: string;
  border: string;
}

export function chalkColors(label: string): ChalkColors {
  const hash = hashLabel(label || "?");
  const hue = hash % 360;
  const sat = 35 + (hash % 12);
  const lift = (hash >> 3) % 10;
  return {
    background: `hsl(${hue} ${sat}% ${77 + lift}%)`,
    foreground: `hsl(${hue} ${Math.min(sat + 10, 82)}% 27%)`,
    border: `hsl(${hue} ${sat}% ${65 + lift}%)`,
  };
}
