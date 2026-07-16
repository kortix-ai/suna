import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { stripHtmlTags } from '@/lib/utils/strip-html-tags';
import { isTextPart, type TextPart, type Turn } from '@/ui';

export interface MinimapItem {
  id: string;
  text: string;
}

export interface MinimapDash {
  item: MinimapItem;
  index: number;
}

// How many dashes the collapsed rail shows at most. Longer sessions are
// down-sampled to this many so the rail stays quiet — every message is still
// listed in the expanded view.
export const MAX_DASHES = 12;

// Rows render a single truncated line; anything past this never shows.
const MAX_ITEM_TEXT = 80;

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '…';
}

export function extractUserText(turn: Turn): string {
  const textParts = turn.userMessage.parts.filter(isTextPart) as TextPart[];
  const raw = textParts.map((p) => p.text).join(' ');
  const clean = stripHtmlTags(stripKortixSystemTags(raw)).replace(/\s+/g, ' ').trim();
  return truncate(clean, MAX_ITEM_TEXT);
}

// Down-sampled set of dashes for the collapsed rail (evenly spaced, always
// including the first and last message).
export function downsampleDashes(items: MinimapItem[], max = MAX_DASHES): MinimapDash[] {
  if (items.length <= max) {
    return items.map((item, index) => ({ item, index }));
  }
  return Array.from({ length: max }, (_, d) => {
    const index = Math.round((d * (items.length - 1)) / (max - 1));
    return { item: items[index], index };
  });
}

// Which dash to light up — the one nearest the active turn.
export function nearestDashIndex(dashes: MinimapDash[], activeIndex: number): number {
  if (activeIndex < 0) return -1;
  let best = -1;
  let bestDist = Infinity;
  for (const dash of dashes) {
    const dist = Math.abs(dash.index - activeIndex);
    if (dist < bestDist) {
      bestDist = dist;
      best = dash.index;
    }
  }
  return best;
}
