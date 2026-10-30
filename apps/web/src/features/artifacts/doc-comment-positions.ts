import {
  artifactCommentAnchorSchema,
  reanchorArtifactText,
  type ArtifactTextAnchor,
} from '@kortix/shared/artifact-comments';
import type { Node as PMNode } from '@tiptap/pm/model';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
type SourceRun = { value: string; start: number; end: number; preserve: boolean };
type PositionRun = { from: number; to: number; start: number; end: number };
export type DocMarkdownPositions = { markdown: string; runs: PositionRun[] };
const parser = unified().use(remarkParse).use(remarkGfm);
let entityDecoder: HTMLTextAreaElement | undefined;

function append(runs: SourceRun[], value: string, start: number, end: number, preserve = false) {
  if (!value) return;
  const previous = runs.at(-1);
  if (
    previous &&
    previous.preserve === preserve &&
    previous.end === start &&
    previous.value.length === previous.end - previous.start &&
    value.length === end - start
  ) {
    previous.value += value;
    previous.end = end;
  } else runs.push({ value, start, end, preserve });
}

function literal(value: string, start: number, preserve: boolean): SourceRun[] {
  const runs: SourceRun[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/\r\n/g)) {
    append(runs, value.slice(cursor, match.index), start + cursor, start + match.index, preserve);
    append(runs, '\n', start + match.index, start + match.index + 2, preserve);
    cursor = match.index + 2;
  }
  append(runs, value.slice(cursor), start + cursor, start + value.length, preserve);
  return runs;
}

function textRuns(value: string, start: number): SourceRun[] {
  const runs: SourceRun[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/\\.|&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi)) {
    const raw = match[0];
    let decoded = raw;
    if (raw[0] === '\\') {
      const code = raw.charCodeAt(1);
      if (!(
        (code >= 33 && code <= 47) ||
        (code >= 58 && code <= 64) ||
        (code >= 91 && code <= 96) ||
        (code >= 123 && code <= 126)
      ))
        continue;
      decoded = raw.slice(1);
    } else {
      entityDecoder ??= new DOMParser().parseFromString('', 'text/html').createElement('textarea');
      entityDecoder.innerHTML = raw;
      decoded = entityDecoder.value;
    }
    append(runs, value.slice(cursor, match.index), start + cursor, start + match.index);
    append(runs, decoded, start + match.index, start + match.index + raw.length);
    cursor = match.index + raw.length;
  }
  append(runs, value.slice(cursor), start + cursor, start + value.length);
  return runs;
}

function collapse(runs: SourceRun[]): SourceRun[] {
  const result: SourceRun[] = [];
  for (const run of runs) {
    if (run.preserve) {
      append(result, run.value, run.start, run.end, true);
      continue;
    }
    let cursor = 0;
    for (const match of run.value.matchAll(/[\t\r\n\f ]+/g)) {
      const linear = run.value.length === run.end - run.start;
      append(
        result,
        run.value.slice(cursor, match.index),
        linear ? run.start + cursor : run.start,
        linear ? run.start + match.index : run.end,
      );
      const start = linear ? run.start + match.index : run.start;
      const end = linear ? start + match[0].length : run.end;
      const previous = result.at(-1);
      if (previous?.value === ' ' && !previous.preserve) previous.end = end;
      else append(result, ' ', start, end);
      cursor = match.index + match[0].length;
    }
    append(
      result,
      run.value.slice(cursor),
      run.value.length === run.end - run.start ? run.start + cursor : run.start,
      run.end,
    );
  }
  const first = result[0];
  if (first && !first.preserve && first.value.startsWith(' ')) {
    first.value = first.value.slice(1);
    first.start++;
  }
  const last = result.at(-1);
  if (last && !last.preserve && last.value.endsWith(' ')) {
    last.value = last.value.slice(0, -1);
    last.end--;
  }
  return result.filter((run) => !!run.value);
}

function inline(node: MdNode, markdown: string): SourceRun[] {
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? start;
  const raw = markdown.slice(start, end);
  if (node.type === 'text') return textRuns(raw, start);
  if (node.type === 'break') return [{ value: '\n', start, end, preserve: true }];
  if (node.type === 'inlineCode') {
    const ticks = /^`+/.exec(raw)?.[0].length ?? 0;
    let content = raw.slice(ticks, raw.length - ticks);
    let offset = start + ticks;
    if (/^[ \r\n]/.test(content) && /[ \r\n]$/.test(content) && /[^ \r\n]/.test(content)) {
      content = content.slice(1, -1);
      offset++;
    }
    return literal(content, offset, false).map((run) => ({
      ...run,
      value: run.value.replace(/[\r\n]/g, ' '),
    }));
  }
  if (node.type === 'image' || node.type === 'imageReference') return [];
  if (node.type === 'html') {
    const document = new DOMParser().parseFromString(raw, 'text/html');
    if (
      document.body.children.length &&
      Array.from(document.body.childNodes).every((child) =>
        child.nodeType === 3
          ? !child.textContent?.trim()
          : child.nodeType === 1 && (child as Element).matches('div.kx-embed'),
      )
    )
      return [];
    const runs: SourceRun[] = [];
    for (const part of raw.matchAll(
      /<!--[\s\S]*?-->|<(script|style|video)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]*>|[^<]+/gi,
    )) {
      if (/^<br\b/i.test(part[0]))
        runs.push({
          value: '\n',
          start: start + part.index,
          end: start + part.index + part[0].length,
          preserve: true,
        });
      else if (part[0][0] !== '<') runs.push(...textRuns(part[0], start + part.index));
    }
    return runs;
  }
  const runs: SourceRun[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'image' || child.type === 'imageReference') {
      const last = runs.at(-1);
      if (last && !last.preserve) {
        const trimmed = last.value.trimEnd();
        last.end -= last.value.length - trimmed.length;
        last.value = trimmed;
      }
    } else runs.push(...inline(child, markdown));
  }
  return runs;
}

function code(node: MdNode, markdown: string): SourceRun[] {
  const start = node.position?.start.offset ?? 0;
  const raw = markdown.slice(start, node.position?.end.offset ?? start);
  const fence = /^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw);
  const from = fence?.[0].length ?? 0;
  let body = raw.slice(from);
  if (fence)
    body = body.replace(
      new RegExp(`(?:\\r?\\n)?[ \\t]*${fence[2]![0]}{${fence[2]!.length},}[ \\t]*$`),
      '',
    );
  const runs: SourceRun[] = [];
  let offset = start + from;
  for (const line of body.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const indent = fence
      ? Math.min(fence[1]!.length, /^ */.exec(line[0])![0].length)
      : (/^(?: {4}|\t)/.exec(line[0])?.[0].length ?? 0);
    runs.push(...literal(line[0].slice(indent), offset + indent, true));
    offset += line[0].length;
  }
  const expected = node.value ?? '';
  const actual = runs.map((run) => run.value).join('');
  if (actual === `${expected}\n`) {
    const last = runs.at(-1)!;
    last.value = last.value.slice(0, -1);
    last.end--;
  }
  return runs;
}

export function docMarkdownPositions(markdown: string, doc: PMNode): DocMarkdownPositions | null {
  const source: SourceRun[] = [];
  const visit = (node: MdNode) => {
    if (node.type === 'code') source.push(...code(node, markdown));
    else if (['paragraph', 'heading', 'tableCell', 'html'].includes(node.type))
      source.push(...collapse(inline(node, markdown)));
    else for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(markdown) as MdNode);
  const rendered: Array<{ value: string; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.isText) rendered.push({ value: node.text!, pos });
    else if (node.type.name === 'hardBreak') rendered.push({ value: '\n', pos });
  });
  const runs: PositionRun[] = [];
  let index = 0;
  let offset = 0;
  for (const run of source) {
    let used = 0;
    while (used < run.value.length) {
      const target = rendered[index];
      if (!target) return null;
      const length = Math.min(run.value.length - used, target.value.length - offset);
      if (run.value.slice(used, used + length) !== target.value.slice(offset, offset + length))
        return null;
      const linear = run.value.length === run.end - run.start;
      runs.push({
        from: target.pos + offset,
        to: target.pos + offset + length,
        start: linear ? run.start + used : run.start,
        end: linear ? run.start + used + length : run.end,
      });
      used += length;
      offset += length;
      if (offset === target.value.length) {
        index++;
        offset = 0;
      }
    }
  }
  return index === rendered.length ? { markdown, runs } : null;
}

export function docRangesForSource(
  map: DocMarkdownPositions | null,
  start: number,
  end: number,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const run of map?.runs ?? []) {
    if (run.start >= end || run.end <= start) continue;
    const linear = run.to - run.from === run.end - run.start;
    const from = linear ? run.from + Math.max(0, start - run.start) : run.from;
    const to = linear ? run.to - Math.max(0, run.end - end) : run.to;
    const previous = ranges.at(-1);
    if (previous?.to === from) previous.to = to;
    else ranges.push({ from, to });
  }
  return ranges;
}

export function docSelectionAnchor(
  map: DocMarkdownPositions | null,
  from: number,
  to: number,
  version: string,
): { anchor: ArtifactTextAnchor } | { error: 'unmapped' | 'ambiguous' } {
  const selected = map?.runs.filter((run) => run.from < to && run.to > from);
  if (!map || !selected?.length || from === to) return { error: 'unmapped' };
  const first = selected[0]!;
  const last = selected.at(-1)!;
  const start =
    first.to - first.from === first.end - first.start
      ? first.start + Math.max(0, from - first.from)
      : first.start;
  const fullEnd =
    last.to - last.from === last.end - last.start ? last.end - Math.max(0, last.to - to) : last.end;
  const limit = Math.min(fullEnd, start + 32);
  let end = start;
  for (const run of selected) {
    if (run.start >= limit) break;
    if (run.to - run.from === run.end - run.start) end = Math.min(run.end, limit);
    else if (run.end <= limit) end = run.end;
    else break;
  }
  if (map.markdown.charCodeAt(end - 1) >= 0xd800 && map.markdown.charCodeAt(end - 1) <= 0xdbff)
    end--;
  if (end <= start) return { error: 'unmapped' };
  let prefix = map.markdown.slice(Math.max(0, start - 32), start);
  let suffix = map.markdown.slice(end, end + 32);
  if (prefix.charCodeAt(0) >= 0xdc00 && prefix.charCodeAt(0) <= 0xdfff) prefix = prefix.slice(1);
  if (
    suffix.charCodeAt(suffix.length - 1) >= 0xd800 &&
    suffix.charCodeAt(suffix.length - 1) <= 0xdbff
  )
    suffix = suffix.slice(0, -1);
  const parsed = artifactCommentAnchorSchema.safeParse({
    type: 'text',
    version,
    quote: map.markdown.slice(start, end),
    prefix,
    suffix,
  });
  if (!parsed.success || parsed.data.type !== 'text') return { error: 'unmapped' };
  const position = reanchorArtifactText(map.markdown, parsed.data);
  if (position.start !== start || position.end !== end) return { error: 'ambiguous' };
  return { anchor: parsed.data };
}
