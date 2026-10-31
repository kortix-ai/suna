import {
  ARTIFACT_ANNOTATION_LIMITS as limits,
  parseArtifactAnnotationFrameMessage,
  type ArtifactAnnotationLayout,
  type ArtifactAnnotationPin,
} from '@kortix/shared/artifact-annotations';
import { artifactCommentAnchorSchema, reanchorArtifactText, type ArtifactCommentAnchor } from '@kortix/shared/artifact-comments';

export type ArtifactAnnotationInventory = {
  revision: number;
  complete: boolean;
  viewport: ArtifactAnnotationLayout['viewport'];
  elements: ArtifactAnnotationLayout['elements'];
  texts: ArtifactAnnotationLayout['texts'];
  text: string;
  spans: { n: number; offset: number; start: number; end: number }[];
};

type Geometry = Pick<ArtifactAnnotationPin, 'rects' | 'ranges'>;
type Position = { start: number; end: number };
export type ArtifactAnnotationResolution = Geometry & (
  | { status: 'resolved'; outdated: false; position: Position | null }
  | { status: 'outdated'; outdated: true; position: null }
  | { status: 'unknown'; outdated: undefined; position: null }
);

export function assembleArtifactAnnotationLayout(chunks: readonly ArtifactAnnotationLayout[]): ArtifactAnnotationInventory | null {
  if (!chunks.length || chunks.length > limits.chunks) return null;
  let inventory: ArtifactAnnotationInventory | null = null;
  let lastElement = -1;
  let lastText = -1;
  let textOffset = 0;
  const rope: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = parseArtifactAnnotationFrameMessage(chunks[index]);
    if (!chunk || chunk.type !== 'layout' || chunk.chunk !== index || chunk.final !== (index === chunks.length - 1)) return null;
    if (!inventory) inventory = { revision: chunk.revision, complete: true, viewport: chunk.viewport, elements: [], texts: [], text: '', spans: [] };
    if (chunk.revision !== inventory.revision || chunk.viewport.width !== inventory.viewport.width
      || chunk.viewport.height !== inventory.viewport.height || chunk.viewport.scroll.x !== inventory.viewport.scroll.x
      || chunk.viewport.scroll.y !== inventory.viewport.scroll.y) return null;
    inventory.complete &&= chunk.complete;
    for (const element of chunk.elements) {
      if (element.n <= lastElement || inventory.elements.length >= limits.elements) return null;
      lastElement = element.n;
      inventory.elements.push(element);
    }
    for (const text of chunk.texts) {
      if (text.n < lastText) return null;
      if (text.n !== lastText) { lastText = text.n; textOffset = 0; }
      if (text.offset !== textOffset) return null;
      const start = inventory.spans.at(-1)?.end ?? 0;
      const end = start + text.text.length;
      if (end > limits.textUnits || text.n >= limits.texts) return null;
      inventory.texts.push(text);
      inventory.spans.push({ n: text.n, offset: text.offset, start, end });
      rope.push(text.text); textOffset += text.text.length;
    }
  }
  inventory!.text = rope.join('');
  return inventory;
}

function missing(complete: boolean): ArtifactAnnotationResolution {
  return complete
    ? { status: 'outdated', outdated: true, position: null, rects: [], ranges: [] }
    : { status: 'unknown', outdated: undefined, position: null, rects: [], ranges: [] };
}

function boundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!));
}

function rangesFor(position: Position, inventory: ArtifactAnnotationInventory): Geometry['ranges'] {
  const ranges: Geometry['ranges'] = [];
  for (const span of inventory.spans) {
    const start = Math.max(position.start, span.start);
    const end = Math.min(position.end, span.end);
    if (end <= start) continue;
    const next = { n: span.n, start: span.offset + start - span.start, end: span.offset + end - span.start };
    const previous = ranges.at(-1);
    if (previous?.n === next.n && previous.end === next.start) previous.end = next.end;
    else ranges.push(next);
  }
  return ranges;
}

export function resolveArtifactAnnotationAnchor(
  anchor: ArtifactCommentAnchor, inventory: ArtifactAnnotationInventory, version: string,
): ArtifactAnnotationResolution {
  const checked = artifactCommentAnchorSchema.safeParse(anchor);
  if (!checked.success) return missing(false);
  anchor = checked.data;
  if (anchor.type === 'none') return { status: 'resolved', outdated: false, position: null, rects: [], ranges: [] };
  if (anchor.type === 'text') {
    if (!inventory.complete) return missing(false);
    const position = reanchorArtifactText(inventory.text, anchor);
    if (position.outdated || position.start === null || position.end === null
      || !boundary(inventory.text, position.start) || !boundary(inventory.text, position.end)) return missing(true);
    const ranges = rangesFor({ start: position.start, end: position.end }, inventory);
    return { status: 'resolved', outdated: false, position: { start: position.start, end: position.end }, rects: [], ranges };
  }

  const selector = anchor.selector;
  const snippet = anchor.snippet;
  const exact = inventory.elements.filter(element => element.selector === selector);
  let element = exact.length === 1 && (snippet ? exact[0]!.snippet === snippet : anchor.version === version) ? exact[0] : undefined;
  if (!element && snippet && inventory.complete) {
    const matches = inventory.elements.filter(candidate => candidate.snippet === snippet);
    if (matches.length === 1) element = matches[0];
  }
  if (!element) return missing(inventory.complete);
  const box = element.rect;
  const rect = { x: box.x + box.width * anchor.offset.x, y: box.y + box.height * anchor.offset.y,
    width: anchor.type === 'region' ? box.width * anchor.offset.width : 1,
    height: anchor.type === 'region' ? box.height * anchor.offset.height : 1 };
  if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0
    || Object.values(rect).some(value => Math.abs(value) > limits.coordinate)) return missing(false);
  return { status: 'resolved', outdated: false, position: { start: element.n, end: element.n + 1 }, rects: [rect], ranges: [] };
}
