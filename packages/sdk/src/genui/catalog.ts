import { createLibrary, defineComponent, type DefinedComponent, type Library } from '@openuidev/lang-core';
import { z } from 'zod/v4';

import type { GenuiNode } from './types';

/** A prop that holds child components. Validated by Kortix, because lang-core does not enforce `.min()`/`.max()`. */
export interface GenuiSlot {
  accepts: readonly string[];
  min: number;
  max: number;
  optional?: boolean;
  /** The slot can hold a component defined later (recursion). Costs prompt detail: the signature shows `any[]`. */
  lazy?: boolean;
}

export type GenuiChildToMarkdown = (node: GenuiNode) => string;

export interface GenuiComponentSpec {
  name: string;
  /** May appear directly inside a Stack, Tab, or AccordionItem. */
  block: boolean;
  /** Counts toward the nesting limit. */
  container: boolean;
  slots: Readonly<Record<string, GenuiSlot>>;
  /** URL props. `required`: an unsafe URL drops the node. `optional`: an unsafe URL drops the prop. */
  urls: Readonly<Record<string, 'required' | 'optional'>>;
  /** Full validation of a finished node (slot children already validated and counted). */
  strict: z.ZodType;
  /** Validation while the block streams: slot minimums are not enforced yet. */
  streaming: z.ZodType;
  toMarkdown(props: Record<string, any>, child: GenuiChildToMarkdown): string;
  /** Text equivalent for screen readers. Charts and maps only. */
  a11y?(props: Record<string, any>): string;
}

type Field = z.ZodType | GenuiSlot;
const isSlot = (field: Field): field is GenuiSlot => 'accepts' in field;

const defined: Record<string, DefinedComponent<any, string>> = {};
const specs: Record<string, GenuiComponentSpec> = {};

function refsOf(names: readonly string[]): z.ZodType {
  const refs = names.map((name) => {
    const component = defined[name];
    if (!component) throw new Error(`genui catalog: ${name} is used before it is defined`);
    return component.ref as z.ZodType;
  });
  return refs.length === 1 ? refs[0]! : z.union(refs as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

function component(input: {
  name: string;
  description: string;
  block?: boolean;
  container?: boolean;
  fields: Record<string, Field>;
  urls?: Record<string, 'required' | 'optional'>;
  toMarkdown: GenuiComponentSpec['toMarkdown'];
  a11y?: GenuiComponentSpec['a11y'];
}): void {
  const openui: Record<string, z.ZodType> = {};
  const strict: Record<string, z.ZodType> = {};
  const streaming: Record<string, z.ZodType> = {};
  const slots: Record<string, GenuiSlot> = {};
  for (const [key, field] of Object.entries(input.fields)) {
    if (!isSlot(field)) {
      openui[key] = field;
      strict[key] = field;
      streaming[key] = field;
      continue;
    }
    slots[key] = field;
    const item = field.lazy ? z.lazy(() => refsOf(field.accepts)) : refsOf(field.accepts);
    const strictArray = z.array(z.unknown()).min(field.min).max(field.max);
    const streamingArray = z.array(z.unknown()).max(field.max);
    openui[key] = field.optional ? z.array(item).optional() : z.array(item);
    strict[key] = field.optional ? strictArray.optional() : strictArray;
    streaming[key] = streamingArray.optional();
  }
  defined[input.name] = defineComponent({
    name: input.name,
    description: input.description,
    props: z.object(openui),
    component: input.name,
  });
  specs[input.name] = {
    name: input.name,
    block: input.block ?? true,
    container: input.container ?? false,
    slots,
    urls: input.urls ?? {},
    strict: z.object(strict),
    streaming: z.object(streaming),
    toMarkdown: input.toMarkdown,
    a11y: input.a11y,
  };
}

// ── Markdown helpers ────────────────────────────────────────────────────────

const cell = (value: unknown): string =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

const mdTable = (head: string[], rows: unknown[][]): string =>
  [
    `| ${head.map(cell).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${head.map((_, i) => cell(row[i] ?? '')).join(' | ')} |`),
  ].join('\n');

const nodes = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

const joinChildren = (value: unknown, child: GenuiChildToMarkdown, separator = '\n\n'): string =>
  nodes(value)
    .map(child)
    .filter((text) => text.length > 0)
    .join(separator);

const formatNumber = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '';

const withUnit = (value: string, unit: unknown): string => (unit ? `${value} ${String(unit)}` : value);

const sourceLine = (source: unknown): string => `Source: ${String(source ?? '')}`;

function seriesTable(labels: string[], series: GenuiNode[], unit: unknown): string {
  const head = ['', ...series.map((s) => withUnit(String(s.props.name ?? ''), unit ? `(${unit})` : ''))];
  const rows = labels.map((label, i) => [
    label,
    ...series.map((s) => formatNumber((s.props.values as unknown[] | undefined)?.[i])),
  ]);
  return mdTable(head, rows);
}

const osmLink = (lat: number, lng: number): string =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

// ── Field shorthands ────────────────────────────────────────────────────────

const text = (max: number) => z.string().min(1).max(max);
const optText = (max: number) => z.string().max(max).optional();
const url = () => z.string().max(2048);

// ── Inline components ───────────────────────────────────────────────────────

component({
  name: 'Badge',
  description: 'Short status tag. tone: neutral, good, warn, bad',
  fields: { label: text(24), tone: z.enum(['neutral', 'good', 'warn', 'bad']).optional() },
  toMarkdown: (p) => `[${p.label}]`,
});

component({
  name: 'Link',
  description: 'A link to a source, booking page, or document',
  fields: { label: text(80), href: url() },
  urls: { href: 'required' },
  toMarkdown: (p) => `[${p.label}](${p.href})`,
});

component({
  name: 'Image',
  description: 'A picture. Use only URLs from tool results or files',
  fields: { src: url(), alt: text(200), caption: optText(200) },
  urls: { src: 'required' },
  toMarkdown: (p) => [`![${p.alt}](${p.src})`, p.caption ? `*${p.caption}*` : ''].filter(Boolean).join('\n\n'),
});

component({
  name: 'Callout',
  description: 'A key takeaway or warning. tone: info, warn, success',
  fields: { tone: z.enum(['info', 'warn', 'success']), body: text(400), title: optText(80) },
  toMarkdown: (p) => `> ${p.title ? `**${p.title}** ` : ''}${p.body}`,
});

// ── Data components ─────────────────────────────────────────────────────────

component({
  name: 'Stat',
  description: 'One key number. trend: up, down, flat',
  fields: {
    label: text(40),
    value: text(24),
    delta: optText(24),
    trend: z.enum(['up', 'down', 'flat']).optional(),
    unit: optText(12),
  },
  toMarkdown: (p) => `**${p.label}:** ${withUnit(String(p.value), p.unit)}${p.delta ? ` (${p.delta})` : ''}`,
});

component({
  name: 'StatRow',
  description: '2 to 4 Stats in a row, for the key numbers of an answer',
  fields: { stats: { accepts: ['Stat'], min: 2, max: 4 } },
  toMarkdown: (p, child) => nodes(p.stats).map((stat) => `- ${child(stat)}`).join('\n'),
});

component({
  name: 'Table',
  description: 'Rows a user scans or sorts. Up to 8 columns and 50 rows',
  fields: {
    columns: z.array(text(40)).min(1).max(8),
    rows: z.array(z.array(z.union([z.string().max(200), z.number()])).max(8)).max(50),
    caption: optText(120),
  },
  toMarkdown: (p) =>
    [p.caption ? `*${p.caption}*` : '', mdTable(p.columns as string[], p.rows as unknown[][])]
      .filter(Boolean)
      .join('\n\n'),
});

component({
  name: 'CompareItem',
  description: 'One option inside Compare. values line up with Compare specs',
  block: false,
  fields: {
    name: text(60),
    values: z.array(z.string().max(120)).max(12),
    pros: z.array(z.string().max(120)).max(5).optional(),
    cons: z.array(z.string().max(120)).max(5).optional(),
  },
  toMarkdown: (p) =>
    [
      `**${p.name}**`,
      ...((p.pros as string[] | undefined) ?? []).map((pro) => `- + ${pro}`),
      ...((p.cons as string[] | undefined) ?? []).map((con) => `- − ${con}`),
    ].join('\n'),
});

component({
  name: 'Compare',
  description: 'Side-by-side comparison of 2 to 4 options. specs are the row labels; winner names the pick',
  fields: {
    items: { accepts: ['CompareItem'], min: 2, max: 4 },
    specs: z.array(text(40)).max(12).optional(),
    winner: optText(60),
  },
  toMarkdown: (p, child) => {
    const items = nodes(p.items);
    const specsList = (p.specs as string[] | undefined) ?? [];
    const parts: string[] = [];
    if (specsList.length > 0) {
      parts.push(
        mdTable(
          ['', ...items.map((item) => String(item.props.name ?? ''))],
          specsList.map((spec, i) => [spec, ...items.map((item) => (item.props.values as string[])[i] ?? '—')]),
        ),
      );
    }
    parts.push(...items.map(child));
    if (p.winner) parts.push(`**Pick:** ${p.winner}`);
    return parts.join('\n\n');
  },
});

component({
  name: 'RankedItem',
  description: 'One entry inside RankedList',
  block: false,
  fields: { title: text(80), reason: text(240), meta: optText(80), image: url().optional(), href: url().optional() },
  urls: { image: 'optional', href: 'optional' },
  toMarkdown: (p) =>
    `**${p.title}** — ${p.reason}${p.meta ? ` (${p.meta})` : ''}${p.href ? ` [Open](${p.href})` : ''}`,
});

component({
  name: 'RankedList',
  description: 'A ranked recommendation, best first. Up to 10 items',
  fields: { items: { accepts: ['RankedItem'], min: 1, max: 10 } },
  toMarkdown: (p, child) => nodes(p.items).map((item, i) => `${i + 1}. ${child(item)}`).join('\n'),
});

// ── Charts ──────────────────────────────────────────────────────────────────

component({
  name: 'Series',
  description: 'One named series of numbers inside a chart',
  block: false,
  fields: { name: text(40), values: z.array(z.number()).max(365) },
  toMarkdown: (p) => `${p.name}: ${(p.values as number[]).map(formatNumber).join(', ')}`,
});

const chartA11y = (kind: string) => (p: Record<string, any>) =>
  `${kind}: ${nodes(p.series)
    .map((s) => s.props.name)
    .join(', ')}. Source: ${p.source}`;

component({
  name: 'BarChart',
  description: 'Amounts across up to 24 categories, up to 4 series. source names where the data came from',
  fields: {
    categories: z.array(text(40)).min(1).max(24),
    series: { accepts: ['Series'], min: 1, max: 4 },
    source: text(200),
    unit: optText(12),
  },
  toMarkdown: (p) =>
    `${seriesTable(p.categories as string[], nodes(p.series), p.unit)}\n\n${sourceLine(p.source)}`,
  a11y: chartA11y('Bar chart'),
});

component({
  name: 'LineChart',
  description: 'A trend over time: x labels, up to 4 series. source names where the data came from',
  fields: {
    x: z.array(text(40)).min(2).max(365),
    series: { accepts: ['Series'], min: 1, max: 4 },
    source: text(200),
    unit: optText(12),
  },
  toMarkdown: (p) => `${seriesTable(p.x as string[], nodes(p.series), p.unit)}\n\n${sourceLine(p.source)}`,
  a11y: chartA11y('Line chart'),
});

component({
  name: 'Slice',
  description: 'One part of a PieChart',
  block: false,
  fields: { label: text(40), value: z.number().nonnegative() },
  toMarkdown: (p) => `${p.label}: ${formatNumber(p.value)}`,
});

component({
  name: 'PieChart',
  description: 'Shares of a whole, 2 to 6 slices. source names where the data came from',
  fields: { slices: { accepts: ['Slice'], min: 2, max: 6 }, source: text(200), unit: optText(12) },
  toMarkdown: (p) => {
    const slices = nodes(p.slices);
    const total = slices.reduce((sum, s) => sum + (Number(s.props.value) || 0), 0);
    const lines = slices.map((s) => {
      const value = Number(s.props.value) || 0;
      const percent = total > 0 ? Math.round((value / total) * 100) : 0;
      return `- ${s.props.label}: ${withUnit(formatNumber(value), p.unit)} (${percent}%)`;
    });
    return `${lines.join('\n')}\n\n${sourceLine(p.source)}`;
  },
  a11y: (p) =>
    `Pie chart: ${nodes(p.slices)
      .map((s) => `${s.props.label} ${formatNumber(s.props.value)}`)
      .join(', ')}. Source: ${p.source}`,
});

// ── Map ─────────────────────────────────────────────────────────────────────

component({
  name: 'Marker',
  description: 'One place on a Map. Coordinates only from tool results or files',
  block: false,
  fields: {
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    label: text(60),
    description: optText(200),
  },
  toMarkdown: (p) =>
    `**${p.label}**${p.description ? ` — ${p.description}` : ''} ([map](${osmLink(p.lat, p.lng)}))`,
});

component({
  name: 'Map',
  description: 'Up to 25 places, zoom 1-18, then an optional route as [lat, lng] pairs. source names where the coordinates came from',
  fields: {
    markers: { accepts: ['Marker'], min: 1, max: 25 },
    source: text(200),
    zoom: z.number().int().min(1).max(18).optional(),
    route: z.array(z.array(z.number()).length(2)).max(500).optional(),
  },
  toMarkdown: (p, child) => `${nodes(p.markers).map((m) => `- ${child(m)}`).join('\n')}\n\n${sourceLine(p.source)}`,
  a11y: (p) =>
    `Map with ${nodes(p.markers).length} places: ${nodes(p.markers)
      .map((m) => m.props.label)
      .join(', ')}. Source: ${p.source}`,
});

// ── Card ────────────────────────────────────────────────────────────────────

component({
  name: 'Card',
  description: 'One item: a hotel, product, or person. body is plain text',
  fields: {
    title: text(80),
    body: optText(600),
    subtitle: optText(120),
    image: url().optional(),
    href: url().optional(),
    badges: { accepts: ['Badge'], min: 0, max: 4, optional: true },
  },
  urls: { image: 'optional', href: 'optional' },
  toMarkdown: (p, child) =>
    [
      `### ${p.title}`,
      p.subtitle ? `*${p.subtitle}*` : '',
      p.body ?? '',
      joinChildren(p.badges, child, ' '),
      p.image ? `![${p.title}](${p.image})` : '',
      p.href ? `[Open](${p.href})` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
});

// ── Containers ──────────────────────────────────────────────────────────────

export const GENUI_BLOCKS = [
  'Stack', 'Card', 'Stat', 'StatRow', 'Table', 'Compare', 'RankedList', 'BarChart', 'LineChart',
  'PieChart', 'Map', 'Tabs', 'Accordion', 'Badge', 'Callout', 'Image', 'Link',
] as const;
const INNER_BLOCKS = GENUI_BLOCKS.filter((name) => name !== 'Tabs' && name !== 'Accordion');

component({
  name: 'Tab',
  description: 'One tab inside Tabs: a label and its blocks',
  block: false,
  fields: { label: text(30), children: { accepts: INNER_BLOCKS, min: 1, max: 8, lazy: true } },
  toMarkdown: (p, child) => `#### ${p.label}\n\n${joinChildren(p.children, child)}`,
});

component({
  name: 'Tabs',
  description: '2 to 5 tabs. Use when content splits into views the user switches between',
  container: true,
  fields: { tabs: { accepts: ['Tab'], min: 2, max: 5 } },
  toMarkdown: (p, child) => joinChildren(p.tabs, child),
});

component({
  name: 'AccordionItem',
  description: 'One collapsible section inside Accordion',
  block: false,
  fields: { title: text(80), children: { accepts: INNER_BLOCKS, min: 1, max: 8, lazy: true } },
  toMarkdown: (p, child) => `#### ${p.title}\n\n${joinChildren(p.children, child)}`,
});

component({
  name: 'Accordion',
  description: 'Up to 10 collapsible sections, for details a reader may skip',
  container: true,
  fields: { items: { accepts: ['AccordionItem'], min: 1, max: 10 } },
  toMarkdown: (p, child) => joinChildren(p.items, child),
});

component({
  name: 'Stack',
  description: 'Layout. root is always a Stack. children: 1 to 12 blocks. direction: col (default) or row',
  container: true,
  fields: {
    children: { accepts: GENUI_BLOCKS, min: 1, max: 12, lazy: true },
    direction: z.enum(['col', 'row']).optional(),
  },
  toMarkdown: (p, child) => joinChildren(p.children, child),
});

export const GENUI_SPECS: Readonly<Record<string, GenuiComponentSpec>> = specs;

export const GENUI_LIBRARY: Library<string> = createLibrary({
  components: Object.values(defined),
  root: 'Stack',
});

/** Maximum container nesting (Stack, Tabs, Accordion) inside one block. */
export const GENUI_MAX_DEPTH = 4;

/** Maximum nodes in one block after references expand. A reference re-materializes its target at every use. */
export const GENUI_MAX_NODES = 500;
