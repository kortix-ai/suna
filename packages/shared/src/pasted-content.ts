import { removeSpans, tagBlocks } from './tag-blocks';

/** Chat pastes at or above this length become a "Pasted text" tile. */
export const PASTE_TILE_MIN_CHARS = 1000;
/** Chat pastes with more lines than this become a tile. */
export const PASTE_TILE_MIN_LINES = 10;
/** Inline tiles may add at most this many UTF-8 bytes to a prompt; larger pastes go out as a file. */
export const PASTED_INLINE_MAX_BYTES = 100_000;

export type PastedContent = { id: string; text: string };

const TAG = 'pasted_content';

export function shouldTilePaste(text: string): boolean {
  return text.length >= PASTE_TILE_MIN_CHARS || text.replace(/[\r\n]+$/, '').split('\n').length > PASTE_TILE_MIN_LINES;
}

/** Math.random, not crypto: this runs in Hermes/React Native without a crypto polyfill. */
export function newPastedContentId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/** `</pasted_content` to `&lt;/pasted_content`, keeping the case, so a body can never close its own block. */
function escapeBody(text: string): string {
  return text.replace(/<\/(pasted_content)/gi, '&lt;/$1');
}

function decodeBody(text: string): string {
  return text.replace(/&lt;\/(pasted_content)/gi, '</$1');
}

export function pastedContentXml(p: PastedContent): string {
  return `<${TAG} id="${p.id}" chars="${p.text.length}">\n${escapeBody(p.text)}\n</${TAG}>`;
}

/** Typed text must never parse as a tile: escape every opening and closing tag the user typed. */
export function neutralizePastedTags(text: string): string {
  return text.replace(/<(\/?pasted_content)/gi, '&lt;$1');
}

/** The exact inverse of `neutralizePastedTags`: what the user typed, for display, Copy and Edit. */
export function restorePastedTags(text: string): string {
  return text.replace(/&lt;(\/?pasted_content)/gi, '<$1');
}

export function serializePromptWithPastes(text: string, pastes: PastedContent[]): string {
  return [...pastes.map(pastedContentXml), neutralizePastedTags(text)].filter((part) => part !== '').join('\n\n');
}

type PastedBlock = { index: number; end: number; id: string; text: string };

/** Blocks whose `id` is set and whose `chars` equals the decoded body length. Others stay text. */
export function pastedContentBlocks(text: string): PastedBlock[] {
  const out: PastedBlock[] = [];
  for (const block of tagBlocks(text, TAG, { attributes: 'spaced' })) {
    const id = /(?:^|\s)id="([^"]*)"/.exec(block.attrs)?.[1];
    const chars = /(?:^|\s)chars="([^"]*)"/.exec(block.attrs)?.[1];
    if (!id || chars === undefined || chars === '') continue;
    let body = block.body;
    if (body.startsWith('\n')) body = body.slice(1);
    if (body.endsWith('\n')) body = body.slice(0, -1);
    body = decodeBody(body);
    if (Number(chars) !== body.length) continue;
    out.push({ index: block.index, end: block.end, id, text: body });
  }
  return out;
}

/** The text without its tiles, and the tiles. Blank lines the serializer put after a block go with it. */
export function splitPastedContent(text: string): { text: string; pastes: PastedContent[] } {
  const blocks = pastedContentBlocks(text);
  if (blocks.length === 0) return { text: restorePastedTags(text), pastes: [] };
  const spans = blocks.map((b) => {
    let end = b.end;
    for (let n = 0; n < 2 && text[end] === '\n'; n++) end++;
    return { index: b.index, end };
  });
  return {
    text: restorePastedTags(removeSpans(text, spans).trim()),
    pastes: blocks.map(({ id, text: body }) => ({ id, text: body })),
  };
}

/** Each valid block replaced by its body, for "Copy message". The typed text around the blocks gets its tags back. */
export function expandPastedContent(text: string): string {
  const blocks = pastedContentBlocks(text);
  let out = '';
  let last = 0;
  for (const b of blocks) {
    out += restorePastedTags(text.slice(last, b.index)) + b.text;
    last = b.end;
  }
  return out + restorePastedTags(text.slice(last));
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
