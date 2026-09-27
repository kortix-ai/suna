/**
 * The Dynamic Context Pruning plugin reports what it pruned in ignored user
 * messages, as `<dcp-notification …>` XML or, before that, as `▣ DCP | …`
 * lines. This reads both. It is pure so `dcp-notification.test.ts` can pin it.
 *
 * The XML blocks come from `tagBlocks`, not a regex. The regex
 * `<dcp-notification\s+([^>]*)>` was quadratic on a single opener followed by
 * whitespace and no `>`: 240k characters took 21 s.
 */

import { replaceSpans, tagBlocks } from '@kortix/shared';

// ============================================================================
// Parse <dcp-notification> XML tags from DCP plugin messages
// ============================================================================

export interface DCPPrunedItem {
  tool: string;
  description: string;
}

export interface DCPNotification {
  type: 'prune' | 'compress';
  tokensSaved: number;
  batchSaved: number;
  prunedCount: number;
  extractedTokens: number;
  reason?: string;
  items: DCPPrunedItem[];
  distilled?: string;
  // compress-specific
  messagesCount?: number;
  toolsCount?: number;
  topic?: string;
  summary?: string;
}

const DCP_ITEM_REGEX = /<dcp-item\s+tool="([^"]*?)"\s+description="([^"]*?)"\s*\/>/g;

/** The body of the first `<name>…</name>` in `text`, or undefined. */
function firstBody(text: string, name: string): string | undefined {
  return tagBlocks(text, name, { limit: 1 })[0]?.body;
}

function unescapeXml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*?)"`);
  const m = attrs.match(re);
  return m ? unescapeXml(m[1]) : undefined;
}

// Legacy DCP format: "▣ DCP | ~12.5K tokens saved total" (pre-XML version)
const DCP_LEGACY_REGEX = /^▣ DCP \| ~([\d.]+K?) tokens saved total/;
const DCP_LEGACY_PRUNING_REGEX =
  /▣ Pruning \(~([\d.]+K?) tokens(?:, distilled ([\d.]+K?) tokens)?\)(?:\s*—\s*(.+))?/;
const DCP_LEGACY_ITEM_REGEX = /→\s+(\S+?):\s+(.+)/g;

function parseLegacyDCPNotification(text: string): DCPNotification | null {
  const headerMatch = text.match(DCP_LEGACY_REGEX);
  if (!headerMatch) return null;

  const tokenStr = headerMatch[1];
  const tokensSaved = tokenStr.endsWith('K')
    ? Math.round(Number.parseFloat(tokenStr.slice(0, -1)) * 1000)
    : Number.parseInt(tokenStr, 10);

  const pruningMatch = text.match(DCP_LEGACY_PRUNING_REGEX);
  let batchSaved = 0;
  let extractedTokens = 0;
  let reason: string | undefined;
  if (pruningMatch) {
    const batchStr = pruningMatch[1];
    batchSaved = batchStr.endsWith('K')
      ? Math.round(Number.parseFloat(batchStr.slice(0, -1)) * 1000)
      : Number.parseInt(batchStr, 10);
    if (pruningMatch[2]) {
      const extStr = pruningMatch[2];
      extractedTokens = extStr.endsWith('K')
        ? Math.round(Number.parseFloat(extStr.slice(0, -1)) * 1000)
        : Number.parseInt(extStr, 10);
    }
    reason = pruningMatch[3]?.trim();
  }

  const items: DCPPrunedItem[] = [];
  let itemMatch;
  DCP_LEGACY_ITEM_REGEX.lastIndex = 0;
  while ((itemMatch = DCP_LEGACY_ITEM_REGEX.exec(text)) !== null) {
    items.push({ tool: itemMatch[1], description: itemMatch[2].trim() });
  }

  // Check for compress format
  const isCompress = text.includes('▣ Compressing');

  return {
    type: isCompress ? 'compress' : 'prune',
    tokensSaved,
    batchSaved,
    prunedCount: items.length,
    extractedTokens,
    reason,
    items,
  };
}

export function parseDCPNotifications(text: string): {
  cleanText: string;
  notifications: DCPNotification[];
} {
  const notifications: DCPNotification[] = [];

  // First try XML format
  const blocks = tagBlocks(text, 'dcp-notification', { attributes: 'spaced' });
  const cleanText = replaceSpans(text, blocks, ({ attrs, body }) => {
    const type = (parseAttr(attrs, 'type') || 'prune') as 'prune' | 'compress';
    const tokensSaved = Number.parseInt(parseAttr(attrs, 'tokens-saved') || '0', 10);
    const batchSaved = Number.parseInt(parseAttr(attrs, 'batch-saved') || '0', 10);
    const prunedCount = Number.parseInt(parseAttr(attrs, 'pruned-count') || '0', 10);
    const extractedTokens = Number.parseInt(parseAttr(attrs, 'extracted-tokens') || '0', 10);
    const reason = parseAttr(attrs, 'reason');

    // Parse items
    const items: DCPPrunedItem[] = [];
    let itemMatch;
    DCP_ITEM_REGEX.lastIndex = 0;
    while ((itemMatch = DCP_ITEM_REGEX.exec(body)) !== null) {
      items.push({
        tool: unescapeXml(itemMatch[1]),
        description: unescapeXml(itemMatch[2]),
      });
    }

    // Parse distilled
    const distilledBody = firstBody(body, 'dcp-distilled');
    const distilled = distilledBody === undefined ? undefined : unescapeXml(distilledBody);

    // Compress-specific
    const messagesCount =
      Number.parseInt(parseAttr(attrs, 'messages-count') || '0', 10) || undefined;
    const toolsCount = Number.parseInt(parseAttr(attrs, 'tools-count') || '0', 10) || undefined;
    const topic = parseAttr(attrs, 'topic');
    const summaryBody = firstBody(body, 'dcp-summary');
    const summary = summaryBody === undefined ? undefined : unescapeXml(summaryBody);

    notifications.push({
      type,
      tokensSaved,
      batchSaved,
      prunedCount,
      extractedTokens,
      reason,
      items,
      distilled,
      messagesCount,
      toolsCount,
      topic,
      summary,
    });
    return '';
  }).trim();

  // If no XML notifications found, try legacy format
  if (notifications.length === 0 && cleanText) {
    const legacy = parseLegacyDCPNotification(cleanText);
    if (legacy) {
      notifications.push(legacy);
      return { cleanText: '', notifications };
    }
  }

  return { cleanText, notifications };
}
