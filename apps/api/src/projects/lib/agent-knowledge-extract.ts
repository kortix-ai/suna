import { parseHTML } from 'linkedom';
import mammoth from 'mammoth';
import Papa from 'papaparse';
import { extractText } from 'unpdf';
import type { KnowledgeDocumentBlock, KnowledgeLocator } from './agent-knowledge-chunking';

export interface ExtractKnowledgeDocumentInput {
  body: Uint8Array;
  contentType: string;
  fileName?: string;
  url?: string;
}

type SupportedDocumentType = 'csv' | 'docx' | 'html' | 'markdown' | 'pdf' | 'text';

const MIME_TYPES: Record<string, SupportedDocumentType> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'markdown',
  'text/plain': 'text',
  'text/x-markdown': 'markdown',
};

const EXTENSIONS: Record<string, SupportedDocumentType> = {
  '.csv': 'csv',
  '.docx': 'docx',
  '.htm': 'html',
  '.html': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.pdf': 'pdf',
  '.txt': 'text',
};

const decoder = new TextDecoder('utf-8', { fatal: false });

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveDocumentType(contentType: string, fileName?: string): SupportedDocumentType {
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (MIME_TYPES[mime]) return MIME_TYPES[mime];
  const extension = fileName?.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (extension && EXTENSIONS[extension]) return EXTENSIONS[extension];
  throw new Error(`Unsupported knowledge document type: ${mime || 'unknown'}.`);
}

function markdownBlocks(value: string, baseLocator: KnowledgeLocator = {}): KnowledgeDocumentBlock[] {
  const blocks: KnowledgeDocumentBlock[] = [];
  const headings: string[] = [];
  let lines: string[] = [];
  let locator = { ...baseLocator };
  let fenced = false;

  const flush = () => {
    const text = normalizeText(lines.join('\n'));
    if (text) blocks.push({ text, locator: { ...locator } });
    lines = [];
  };

  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) {
      lines.push(line);
      continue;
    }
    flush();
    const level = heading[1]!.length;
    headings[level - 1] = normalizeText(heading[2]!);
    headings.length = level;
    const headingPath = headings.filter(Boolean).join(' > ');
    locator = { ...baseLocator, heading: headingPath };
    lines.push(heading[2]!);
  }
  flush();
  return blocks;
}

const CONTENT_TAGS = new Set([
  'ADDRESS',
  'BLOCKQUOTE',
  'CAPTION',
  'CODE',
  'DD',
  'DT',
  'FIGCAPTION',
  'LI',
  'P',
  'PRE',
  'TD',
  'TH',
]);

function htmlBlocks(value: string, baseLocator: KnowledgeLocator): KnowledgeDocumentBlock[] {
  const { document } = parseHTML(value);
  for (const element of document.querySelectorAll(
    'script, style, nav, footer, noscript, template, svg, canvas, iframe',
  )) {
    element.remove();
  }

  const blocks: KnowledgeDocumentBlock[] = [];
  const headings: string[] = [];
  let parts: string[] = [];
  let locator = { ...baseLocator };

  const flush = () => {
    const text = normalizeText(parts.join('\n\n'));
    if (text) blocks.push({ text, locator: { ...locator } });
    parts = [];
  };

  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const text = normalizeText(node.textContent ?? '');
      if (text) parts.push(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tagName = element.tagName.toUpperCase();
    const match = /^H([1-6])$/.exec(tagName);
    if (match) {
      flush();
      const heading = normalizeText(element.textContent ?? '');
      if (!heading) return;
      const level = Number(match[1]);
      headings[level - 1] = heading;
      headings.length = level;
      locator = { ...baseLocator, heading: headings.filter(Boolean).join(' > ') };
      parts.push(heading);
      return;
    }
    if (CONTENT_TAGS.has(tagName)) {
      const text = normalizeText(element.textContent ?? '');
      if (text) parts.push(text);
      return;
    }
    for (const child of Array.from(element.childNodes)) visit(child);
  };

  const root = document.body ?? document.documentElement;
  for (const child of Array.from(root.childNodes)) visit(child);
  flush();
  return blocks;
}

function csvBlocks(value: string): KnowledgeDocumentBlock[] {
  const parsed = Papa.parse<Record<string, string>>(value, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => normalizeText(header),
  });
  if (parsed.errors.length > 0) {
    throw new Error(`CSV extraction failed: ${parsed.errors[0]!.message}`);
  }
  return parsed.data.flatMap((row, index) => {
    const text = Object.entries(row)
      .filter(([key, cell]) => key && cell != null && normalizeText(String(cell)))
      .map(([key, cell]) => `${key}: ${normalizeText(String(cell))}`)
      .join('\n');
    return text ? [{ text, locator: { row: index + 2 } }] : [];
  });
}

export async function extractKnowledgeDocument(
  input: ExtractKnowledgeDocumentInput,
): Promise<KnowledgeDocumentBlock[]> {
  const type = resolveDocumentType(input.contentType, input.fileName);
  const baseLocator = input.url ? { url: input.url } : {};
  let blocks: KnowledgeDocumentBlock[];

  switch (type) {
    case 'pdf': {
      const result = await extractText(input.body, { mergePages: false });
      blocks = result.text.flatMap((text, index) => {
        const normalized = normalizeText(text);
        return normalized ? [{ text: normalized, locator: { ...baseLocator, page: index + 1 } }] : [];
      });
      break;
    }
    case 'docx': {
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(input.body) });
      blocks = htmlBlocks(result.value, baseLocator);
      break;
    }
    case 'html':
      blocks = htmlBlocks(decoder.decode(input.body), baseLocator);
      break;
    case 'markdown':
      blocks = markdownBlocks(decoder.decode(input.body), baseLocator);
      break;
    case 'csv':
      blocks = csvBlocks(decoder.decode(input.body));
      break;
    case 'text': {
      const text = normalizeText(decoder.decode(input.body));
      blocks = text ? [{ text, locator: baseLocator }] : [];
      break;
    }
  }

  if (blocks.length === 0) throw new Error('Knowledge document contains no indexable text.');
  return blocks;
}
