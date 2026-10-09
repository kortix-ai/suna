import { useId, useState, type CSSProperties, type ReactNode } from 'react';

import { genuiA11yText, type GenuiNode } from '../index';
import type { GenuiComponentMap, GenuiComponentProps } from './genui-block';

/**
 * Unbranded default components for third-party hosts. Semantic HTML, themed through CSS variables
 * (`--genui-fg`, `--genui-muted`, `--genui-border`, `--genui-surface`, `--genui-accent`, `--genui-radius`).
 * Charts and maps render as accessible data tables and place lists: a host that wants drawn charts
 * passes its own components for those names. Kortix web and mobile pass their own map entirely.
 */

const v = (name: string, fallback: string) => `var(--genui-${name}, ${fallback})`;
const box: CSSProperties = {
  border: `1px solid ${v('border', 'rgba(0,0,0,.12)')}`,
  borderRadius: v('radius', '10px'),
  background: v('surface', 'transparent'),
  padding: 12,
};
const muted: CSSProperties = { color: v('muted', 'rgba(0,0,0,.6)'), fontSize: 13 };
const TONE: Record<string, string> = { good: '#15803d', warn: '#b45309', bad: '#b91c1c', neutral: 'inherit' };

const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

function DataTable({ head, rows, caption }: { head: string[]; rows: unknown[][]; caption?: ReactNode }) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
      {caption ? <caption style={{ ...muted, textAlign: 'left', captionSide: 'bottom', paddingTop: 6 }}>{caption}</caption> : null}
      <thead>
        <tr>
          {head.map((cell, i) => (
            <th key={i} scope="col" style={{ textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${v('border', 'rgba(0,0,0,.12)')}` }}>
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {head.map((_, c) => (
              <td key={c} style={{ padding: '6px 8px' }}>
                {String(row[c] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function seriesRows(labels: string[], series: GenuiNode[]): unknown[][] {
  return labels.map((label, i) => [label, ...series.map((s) => (s.props.values as number[] | undefined)?.[i] ?? '')]);
}

const Stack = ({ props, renderChild }: GenuiComponentProps) => (
  <div style={{ display: 'flex', flexDirection: props.direction === 'row' ? 'row' : 'column', flexWrap: 'wrap', gap: 12 }}>
    {kids(props.children).map(renderChild)}
  </div>
);

const Card = ({ props, renderChild }: GenuiComponentProps) => (
  <article style={box}>
    {props.image ? <img src={props.image} alt="" style={{ width: '100%', borderRadius: 6, marginBottom: 8 }} /> : null}
    <h4 style={{ margin: 0 }}>{props.href ? <a href={props.href} target="_blank" rel="noopener noreferrer">{props.title}</a> : props.title}</h4>
    {props.subtitle ? <p style={muted}>{props.subtitle}</p> : null}
    {props.body ? <p style={{ margin: '6px 0 0' }}>{props.body}</p> : null}
    {kids(props.badges).length > 0 ? <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>{kids(props.badges).map(renderChild)}</div> : null}
  </article>
);

const Stat = ({ props }: GenuiComponentProps) => (
  <div style={{ ...box, minWidth: 120 }}>
    <div style={muted}>{props.label}</div>
    <div style={{ fontSize: 22, fontWeight: 600 }}>
      {props.value}
      {props.unit ? <span style={muted}> {props.unit}</span> : null}
    </div>
    {props.delta ? <div style={{ color: TONE[props.trend === 'down' ? 'bad' : props.trend === 'up' ? 'good' : 'neutral'] }}>{props.delta}</div> : null}
  </div>
);

const StatRow = ({ props, renderChild }: GenuiComponentProps) => (
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{kids(props.stats).map(renderChild)}</div>
);

const Table = ({ props }: GenuiComponentProps) => <DataTable head={props.columns} rows={props.rows} caption={props.caption} />;

const Compare = ({ props }: GenuiComponentProps) => {
  const items = kids(props.items);
  const specs: string[] = props.specs ?? [];
  return (
    <div style={box}>
      {specs.length > 0 ? (
        <DataTable
          head={['', ...items.map((item) => String(item.props.name))]}
          rows={specs.map((spec, i) => [spec, ...items.map((item) => (item.props.values as string[])[i] ?? '—')])}
        />
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 12, marginTop: 8 }}>
        {items.map((item) => (
          <div key={item.id}>
            <strong>{String(item.props.name)}{props.winner === item.props.name ? ' ✓' : ''}</strong>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {((item.props.pros as string[] | undefined) ?? []).map((pro, i) => <li key={`p${i}`}>+ {pro}</li>)}
              {((item.props.cons as string[] | undefined) ?? []).map((con, i) => <li key={`c${i}`}>− {con}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
};

const RankedList = ({ props }: GenuiComponentProps) => (
  <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8 }}>
    {kids(props.items).map((item) => (
      <li key={item.id}>
        <strong>{item.props.href ? <a href={String(item.props.href)} target="_blank" rel="noopener noreferrer">{String(item.props.title)}</a> : String(item.props.title)}</strong>
        {item.props.meta ? <span style={muted}> · {String(item.props.meta)}</span> : null}
        <div>{String(item.props.reason)}</div>
      </li>
    ))}
  </ol>
);

const SeriesChart = ({ node, props }: GenuiComponentProps) => {
  const labels: string[] = props.categories ?? props.x ?? [];
  const series = kids(props.series);
  return (
    <figure style={{ ...box, margin: 0 }} aria-label={genuiA11yText(node) ?? undefined}>
      <DataTable head={['', ...series.map((s) => String(s.props.name))]} rows={seriesRows(labels, series)} caption={`Source: ${props.source}`} />
    </figure>
  );
};

const PieChart = ({ node, props }: GenuiComponentProps) => (
  <figure style={{ ...box, margin: 0 }} aria-label={genuiA11yText(node) ?? undefined}>
    <DataTable head={['', props.unit ?? '']} rows={kids(props.slices).map((s) => [s.props.label, s.props.value])} caption={`Source: ${props.source}`} />
  </figure>
);

const Map = ({ node, props }: GenuiComponentProps) => (
  <figure style={{ ...box, margin: 0 }} aria-label={genuiA11yText(node) ?? undefined}>
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {kids(props.markers).map((m) => (
        <li key={m.id}>
          <a href={`https://www.openstreetmap.org/?mlat=${m.props.lat}&mlon=${m.props.lng}#map=15/${m.props.lat}/${m.props.lng}`} target="_blank" rel="noopener noreferrer">
            {String(m.props.label)}
          </a>
          {m.props.description ? ` — ${String(m.props.description)}` : ''}
        </li>
      ))}
    </ul>
    <figcaption style={muted}>Source: {props.source}</figcaption>
  </figure>
);

const Tabs = ({ props, renderChild }: GenuiComponentProps) => {
  const tabs = kids(props.tabs);
  const [active, setActive] = useState(0);
  const base = useId();
  const current = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div>
      <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${v('border', 'rgba(0,0,0,.12)')}` }}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            role="tab"
            id={`${base}-t${i}`}
            aria-selected={i === active}
            aria-controls={`${base}-p${i}`}
            onClick={() => setActive(i)}
            style={{ padding: '6px 10px', border: 0, background: 'none', borderBottom: i === active ? `2px solid ${v('accent', 'currentColor')}` : '2px solid transparent', cursor: 'pointer' }}
          >
            {String(tab.props.label)}
          </button>
        ))}
      </div>
      {current ? (
        <div role="tabpanel" id={`${base}-p${active}`} aria-labelledby={`${base}-t${active}`} style={{ paddingTop: 12, display: 'grid', gap: 12 }}>
          {kids(current.props.children).map(renderChild)}
        </div>
      ) : null}
    </div>
  );
};

const Accordion = ({ props, renderChild }: GenuiComponentProps) => (
  <div style={{ display: 'grid', gap: 6 }}>
    {kids(props.items).map((item) => (
      <details key={item.id} style={box}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{String(item.props.title)}</summary>
        <div style={{ paddingTop: 8, display: 'grid', gap: 12 }}>{kids(item.props.children).map(renderChild)}</div>
      </details>
    ))}
  </div>
);

const Badge = ({ props }: GenuiComponentProps) => (
  <span style={{ border: `1px solid ${v('border', 'rgba(0,0,0,.12)')}`, borderRadius: 999, padding: '1px 8px', fontSize: 12, color: TONE[props.tone ?? 'neutral'] }}>
    {props.label}
  </span>
);

const Callout = ({ props }: GenuiComponentProps) => (
  <aside role="note" style={{ ...box, borderLeft: `3px solid ${TONE[props.tone === 'warn' ? 'warn' : props.tone === 'success' ? 'good' : 'neutral']}` }}>
    {props.title ? <strong>{props.title} </strong> : null}
    {props.body}
  </aside>
);

const Image = ({ props }: GenuiComponentProps) => (
  <figure style={{ margin: 0 }}>
    <img src={props.src} alt={props.alt} style={{ maxWidth: '100%', borderRadius: 6 }} />
    {props.caption ? <figcaption style={muted}>{props.caption}</figcaption> : null}
  </figure>
);

const Link = ({ props }: GenuiComponentProps) => (
  <a href={props.href} target="_blank" rel="noopener noreferrer">
    {props.label}
  </a>
);

export const defaultGenuiComponents: GenuiComponentMap = {
  Stack,
  Card,
  Stat,
  StatRow,
  Table,
  Compare,
  RankedList,
  BarChart: SeriesChart,
  LineChart: SeriesChart,
  PieChart,
  Map,
  Tabs,
  Accordion,
  Badge,
  Callout,
  Image,
  Link,
};
