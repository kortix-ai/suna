import {
  ARTIFACT_ANNOTATION_LIMITS as limits,
  type ArtifactAnnotationCandidate,
  type ArtifactAnnotationLayout,
} from '@kortix/shared/artifact-annotations';
import { ARTIFACT_TEXT_CONTEXT_MAX, ARTIFACT_TEXT_QUOTE_MAX } from '@kortix/shared/artifact-comments';

type Rect = ArtifactAnnotationLayout['elements'][number]['rect'];
export type AnnotationInventory = {
  elements: ArtifactAnnotationLayout['elements'];
  texts: ArtifactAnnotationLayout['texts'];
  textNodes: Text[];
  elementNodes: Element[];
  complete: boolean;
};
const excluded = 'script,style,noscript,template,input,textarea,select,option,[contenteditable],[hidden],[inert],[aria-hidden="true"],[data-kortix-annotation-overlay]';

export function safeAnnotationSlice(text: string, start: number, end: number): string {
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '') && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start++;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  return text.slice(start, end);
}

export function annotationRect(rect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>, scrollX = 0, scrollY = 0): Rect | null {
  const value = { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
  if (!Object.values(value).every(Number.isFinite) || value.width <= 0 || value.height <= 0
    || Object.values(value).some(number => Math.abs(number) > limits.coordinate)) return null;
  return value;
}

export function annotationSelector(element: Element): string | null {
  const parts: string[] = [];
  const document = element.ownerDocument;
  const escape = document.defaultView!.CSS.escape;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const id = node.id;
    if (id && !/[\0\uD800-\uDFFF]/u.test(id)) {
      const selector = `#${escape(id)}`;
      try {
        if (document.querySelectorAll(selector).length === 1) { parts.unshift(selector); break; }
      } catch {}
    }
    const tag = node.localName;
    let part = escape(tag);
    const parent = node.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter(sibling => sibling.localName === tag);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (parts.join(' > ').length > 2048) return null;
  }
  const selector = parts.join(' > ');
  return selector.length <= 2048 ? selector : null;
}

function visible(element: Element): boolean {
  if (element.matches(excluded)) return false;
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

export function annotationInventory(document: Document): AnnotationInventory {
  const inventory: AnnotationInventory = { elements: [], texts: [], textNodes: [], elementNodes: [], complete: true };
  const view = document.defaultView!;
  if (!document.body || !visible(document.body)) return inventory;
  const indices = new WeakMap<Element, number>();
  const snippets: string[] = [];
  let pageSnippet = '';
  const walker = document.createTreeWalker(document.body, 5, {
    acceptNode: node => node.nodeType === 1 && !visible(node as Element) ? 2 : 1,
  });
  // Snippets read like the rendered page: text from two different blocks ("Free" in an h2,
  // "$0" in a p) is joined with a space; inline runs ("One <b>project</b>,") stay joined.
  const inline = new WeakMap<Element, boolean>();
  const isInline = (element: Element) => {
    let value = inline.get(element);
    if (value === undefined) {
      const display = view.getComputedStyle(element).display;
      // An empty value is the initial value, `inline`.
      value = !display || display.startsWith('inline') || display === 'contents';
      inline.set(element, value);
    }
    return value;
  };
  const blockBetween = (previous: Text, current: Text) => {
    const ancestors = new Set<Element>();
    for (let element = previous.parentElement; element; element = element.parentElement) ancestors.add(element);
    let common: Element | null = null;
    for (let element = current.parentElement; element; element = element.parentElement) {
      if (ancestors.has(element)) { common = element; break; }
      if (!isInline(element)) return true;
    }
    for (let element = previous.parentElement; element && element !== common; element = element.parentElement) {
      if (!isInline(element)) return true;
    }
    return false;
  };
  const appendSnippet = (current: string, run: string, separate: boolean) =>
    safeAnnotationSlice((current + (separate && current ? ' ' : '') + run).replace(/\s+/g, ' ').trimStart(), 0, 122);
  let previousText: Text | null = null;
  let units = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) {
      if (inventory.elements.length >= limits.elements - 1) { inventory.complete = false; continue; }
      const element = node as Element;
      const rect = annotationRect(element.getBoundingClientRect(), view.scrollX, view.scrollY);
      const selector = rect && annotationSelector(element);
      if (rect && selector) {
        const n = inventory.elementNodes.length;
        inventory.elements.push({ n, selector, snippet: '', rect });
        indices.set(element, n); snippets.push('');
        inventory.elementNodes.push(element);
      }
    } else if (node.nodeType === 3 && node.textContent) {
      if (inventory.textNodes.length >= limits.texts || units >= limits.textUnits) { inventory.complete = false; continue; }
      const textNode = node as Text;
      const n = inventory.textNodes.length;
      inventory.textNodes.push(textNode);
      let separate = previousText !== null && blockBetween(previousText, textNode);
      previousText = textNode;
      let offset = 0;
      let run = '';
      let runStart = 0;
      const flush = () => {
        if (run) {
          inventory.texts.push({ n, offset: runStart, text: run });
          for (let parent = textNode.parentElement; parent; parent = parent.parentElement) {
            const index = indices.get(parent);
            if (index !== undefined && snippets[index]!.length < 122) snippets[index] = appendSnippet(snippets[index]!, run, separate);
          }
          if (pageSnippet.length < 122) pageSnippet = appendSnippet(pageSnippet, run, separate);
          separate = false;
        }
        run = '';
      };
      for (const character of textNode.data) {
        if (units + character.length > limits.textUnits) { flush(); inventory.complete = false; break; }
        if (character === '\0' || /[\uD800-\uDFFF]/u.test(character)) {
          flush(); offset += character.length; continue;
        }
        if (run.length + character.length > 4096) flush();
        if (!run) runStart = offset;
        run += character; units += character.length; offset += character.length;
      }
      flush();
    }
  }
  for (const item of inventory.elements) {
    item.snippet = safeAnnotationSlice(snippets[item.n]!.trim(), 0, 120);
  }
  const root = annotationRect({ x: 0, y: 0, width: Math.max(view.innerWidth, document.documentElement.scrollWidth), height: Math.max(view.innerHeight, document.documentElement.scrollHeight) });
  if (root && inventory.elements.length < limits.elements) {
    const n = inventory.elementNodes.length;
    inventory.elements.push({ n, selector: 'html', snippet: safeAnnotationSlice(pageSnippet.trim(), 0, 120), rect: root });
    inventory.elementNodes.push(document.documentElement);
  }
  return inventory;
}

/** The selection as a text candidate; 'too_long' when it exceeds a text anchor; null when nothing is selected. */
export function annotationSelection(selection: Selection | null, inventory: AnnotationInventory): ArtifactAnnotationCandidate | 'too_long' | null {
  if (!inventory.complete || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const text = inventory.texts.map(part => part.text).join('');
  let base = 0;
  let start: number | null = null;
  let end = 0;
  for (const part of inventory.texts) {
    const node = inventory.textNodes[part.n]!;
    if (range.intersectsNode(node)) {
      let from = part.offset;
      let to = part.offset + part.text.length;
      while (from < to && range.comparePoint(node, from) < 0) {
        let low = from + 1; let high = to;
        while (low < high) { const middle = (low + high) >>> 1; if (range.comparePoint(node, middle) < 0) low = middle + 1; else high = middle; }
        from = low;
      }
      if (range.comparePoint(node, to) > 0) {
        let low = from; let high = to;
        while (low < high) { const middle = (low + high + 1) >>> 1; if (range.comparePoint(node, middle) > 0) high = middle - 1; else low = middle; }
        to = low;
      }
      if (to > from) { start ??= base + from - part.offset; end = base + to - part.offset; }
    }
    base += part.text.length;
  }
  if (start === null || end <= start) return null;
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? '') && /[\uD800-\uDBFF]/.test(text[start - 1] ?? '')) start++;
  // The whole selection is the quote. A longer one is refused, never cut: a cut quote anchors a different passage.
  const quote = safeAnnotationSlice(text, start, end);
  if (!quote.trim()) return null;
  if (quote.length > ARTIFACT_TEXT_QUOTE_MAX) return 'too_long';
  return {
    type: 'text', quote,
    prefix: safeAnnotationSlice(text, Math.max(0, start - ARTIFACT_TEXT_CONTEXT_MAX), start),
    suffix: safeAnnotationSlice(text, start + quote.length, start + quote.length + ARTIFACT_TEXT_CONTEXT_MAX),
  };
}

export function annotationPoint(
  element: ArtifactAnnotationLayout['elements'][number],
  start: { x: number; y: number }, end: { x: number; y: number }, viewportWidth: number,
  scroll: { x: number; y: number },
): ArtifactAnnotationCandidate {
  const rect = element.rect;
  const x = (value: number) => Math.min(1, Math.max(0, (value - rect.x) / rect.width));
  const y = (value: number) => Math.min(1, Math.max(0, (value - rect.y) / rect.height));
  const shared = { selector: element.selector, snippet: element.snippet, viewport_width: viewportWidth, scroll };
  const x1 = x(start.x); const x2 = x(end.x); const y1 = y(start.y); const y2 = y(end.y);
  if (Math.hypot(end.x - start.x, end.y - start.y) < 4 || x1 === x2 || y1 === y2) {
    return { ...shared, type: 'point', offset: { x: x2, y: y2 } };
  }
  return { ...shared, type: 'region', offset: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) } };
}

export function annotationLayoutChunks(inventory: AnnotationInventory, revision: number, viewport: ArtifactAnnotationLayout['viewport']): ArtifactAnnotationLayout[] {
  const chunks: ArtifactAnnotationLayout[] = [];
  const make = (): ArtifactAnnotationLayout => ({ kortix: 'annotate', v: 1, type: 'layout', revision, chunk: chunks.length, final: false, complete: inventory.complete, viewport, elements: [], texts: [] });
  let chunk = make();
  let truncated = false;
  const items = [...inventory.elements.map(element => ({ kind: 'elements' as const, value: element })), ...inventory.texts.map(text => ({ kind: 'texts' as const, value: text }))];
  for (const item of items) {
    const array = chunk[item.kind] as Array<typeof item.value>;
    array.push(item.value);
    if (chunk.elements.length + chunk.texts.length > limits.chunkItems || new TextEncoder().encode(JSON.stringify(chunk)).byteLength > limits.messageBytes - 16) {
      array.pop(); chunks.push(chunk);
      if (chunks.length >= limits.chunks) { truncated = true; break; }
      chunk = make();
      (chunk[item.kind] as Array<typeof item.value>).push(item.value);
    }
  }
  if (!truncated) chunks.push(chunk);
  const last = chunks.at(-1)!;
  last.final = true;
  if (truncated) for (const part of chunks) part.complete = false;
  return chunks;
}
