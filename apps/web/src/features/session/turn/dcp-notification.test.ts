import { describe, expect, test } from 'bun:test';

import { parseDCPNotifications } from './dcp-notification';

// The regex version of this parser, kept ONLY as a parity oracle. Its
// `<dcp-notification\s+([^>]*)>` was quadratic on one opener: `\s+` and
// `[^>]*` both match whitespace, so a long space run with no `>` was split
// every way.
// ============================================================================
// Parse <dcp-notification> XML tags from DCP plugin messages
// ============================================================================

interface LegacyItem {
  tool: string;
  description: string;
}

interface LegacyNotification {
  type: 'prune' | 'compress';
  tokensSaved: number;
  batchSaved: number;
  prunedCount: number;
  extractedTokens: number;
  reason?: string;
  items: LegacyItem[];
  distilled?: string;
  // compress-specific
  messagesCount?: number;
  toolsCount?: number;
  topic?: string;
  summary?: string;
}

const DCP_TAG_REGEX = /<dcp-notification\s+([^>]*)>([\s\S]*?)<\/dcp-notification>/g;
const DCP_ITEM_REGEX = /<dcp-item\s+tool="([^"]*?)"\s+description="([^"]*?)"\s*\/>/g;
const DCP_DISTILLED_REGEX = /<dcp-distilled>([\s\S]*?)<\/dcp-distilled>/;
const DCP_SUMMARY_REGEX = /<dcp-summary>([\s\S]*?)<\/dcp-summary>/;

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

function parseLegacyLegacyNotification(text: string): LegacyNotification | null {
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

  const items: LegacyItem[] = [];
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

function legacyParse(text: string): {
  cleanText: string;
  notifications: LegacyNotification[];
} {
  const notifications: LegacyNotification[] = [];

  // First try XML format
  const cleanText = text
    .replace(DCP_TAG_REGEX, (_, attrs: string, body: string) => {
      const type = (parseAttr(attrs, 'type') || 'prune') as 'prune' | 'compress';
      const tokensSaved = Number.parseInt(parseAttr(attrs, 'tokens-saved') || '0', 10);
      const batchSaved = Number.parseInt(parseAttr(attrs, 'batch-saved') || '0', 10);
      const prunedCount = Number.parseInt(parseAttr(attrs, 'pruned-count') || '0', 10);
      const extractedTokens = Number.parseInt(parseAttr(attrs, 'extracted-tokens') || '0', 10);
      const reason = parseAttr(attrs, 'reason');

      // Parse items
      const items: LegacyItem[] = [];
      let itemMatch;
      DCP_ITEM_REGEX.lastIndex = 0;
      while ((itemMatch = DCP_ITEM_REGEX.exec(body)) !== null) {
        items.push({
          tool: unescapeXml(itemMatch[1]),
          description: unescapeXml(itemMatch[2]),
        });
      }

      // Parse distilled
      const distilledMatch = body.match(DCP_DISTILLED_REGEX);
      const distilled = distilledMatch ? unescapeXml(distilledMatch[1]) : undefined;

      // Compress-specific
      const messagesCount =
        Number.parseInt(parseAttr(attrs, 'messages-count') || '0', 10) || undefined;
      const toolsCount = Number.parseInt(parseAttr(attrs, 'tools-count') || '0', 10) || undefined;
      const topic = parseAttr(attrs, 'topic');
      const summaryMatch = body.match(DCP_SUMMARY_REGEX);
      const summary = summaryMatch ? unescapeXml(summaryMatch[1]) : undefined;

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
    })
    .trim();

  // If no XML notifications found, try legacy format
  if (notifications.length === 0 && cleanText) {
    const legacy = parseLegacyLegacyNotification(cleanText);
    if (legacy) {
      notifications.push(legacy);
      return { cleanText: '', notifications };
    }
  }

  return { cleanText, notifications };
}

/** Deterministic PRNG (mulberry32), so a failing case reproduces. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseDCPNotifications', () => {
  test('returns exactly what the regex version returned on 3000 random messages', () => {
    const tokens = ['<dcp-notification type="prune" tokens-saved="12" batch-saved="3" pruned-count="1">',
      '<dcp-notification type="compress" topic="t" messages-count="4">', '<dcp-notification', ' ', '\t', '>',
      '</dcp-notification>', '<dcp-item tool="bash" description="ls"/>', '<dcp-item tool="a&amp;b" description="x" />',
      '<dcp-distilled>', '</dcp-distilled>', '<dcp-summary>', '</dcp-summary>', 'x', '\n', 'text',
      '▣ DCP | ~12.5K tokens saved total', '▣ Pruning (~3K tokens) — stale', '→ bash: ls', '▣ Compressing'];
    const next = random(61);
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const length = Math.floor(next() * 14);
      for (let j = 0; j < length; j++) text += tokens[Math.floor(next() * tokens.length)];
      const expected = legacyParse(text);
      expect(parseDCPNotifications(text)).toEqual(expected);
      if (expected.notifications.length) found++;
    }
    expect(found).toBeGreaterThan(300);
  });

  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  // The regex took 1.3 s at 60k characters and quadrupled per doubling.
  within('one opener followed by 240k spaces and no >', () => parseDCPNotifications(`<dcp-notification${' '.repeat(240_000)}x`));
  within('16k <dcp-distilled> openers that never close', () =>
    parseDCPNotifications(`<dcp-notification type="prune">${'<dcp-distilled>'.repeat(16_000)}</dcp-notification>`));
});
