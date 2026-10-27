import { parse as parseYaml } from 'yaml';

import type { Block } from '@/components/blog/blog-content';

/**
 * A fenced block whose language is a rich block type (```compare, ```verdict,
 * ```logos, ```cta) is that block, with its YAML body as the data. Parsed
 * here for the page (blog-markdown.tsx) and for the tests, so a block the
 * page could not render fails the test run, before the build.
 */
export const RICH_BLOCKS = new Set(['compare', 'verdict', 'logos', 'cta']);

const FIELDS: Record<string, string[]> = {
  compare: ['them', 'rows'],
  verdict: ['themLabel', 'them', 'kortix'],
  logos: ['items'],
  cta: ['title'],
};
const ENTRY_FIELDS: Record<string, [string, string[]]> = {
  compare: ['rows', ['dimension', 'them', 'kortix']],
  logos: ['items', ['domain', 'name']],
};

export function parseRichBlock(lang: string, source: string): Block {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    throw new Error(`\`\`\`${lang} block is not valid YAML: ${(e as Error).message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`\`\`\`${lang} block must be a YAML mapping`);
  }
  const record = data as Record<string, unknown>;
  for (const field of FIELDS[lang] ?? []) {
    if (!record[field]) throw new Error(`\`\`\`${lang} block needs \`${field}\``);
  }
  const entries = ENTRY_FIELDS[lang];
  if (entries) {
    const [key, needed] = entries;
    (record[key] as Record<string, unknown>[]).forEach((entry, i) => {
      const missing = needed.filter((f) => !entry?.[f]);
      if (missing.length) {
        throw new Error(`\`\`\`${lang} block: entry ${i + 1} needs ${missing.join(', ')}`);
      }
    });
  }
  return { type: lang, ...record } as Block;
}

/** Every rich block fenced in a post's Markdown. */
export function richBlocksIn(markdown: string): { lang: string; source: string }[] {
  const out: { lang: string; source: string }[] = [];
  for (const m of markdown.matchAll(/^```([a-z]+)[ \t]*\n([\s\S]*?)^```/gm)) {
    if (RICH_BLOCKS.has(m[1])) out.push({ lang: m[1], source: m[2] });
  }
  return out;
}
