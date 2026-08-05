/**
 * Row model and renderers for `pnpm worktree list`.
 *
 * Everything here is pure: it takes a registry snapshot plus a set of listening
 * ports and returns lines. No process spawning, no console, no registry writes —
 * `list` is a read-only view, and drift repair stays `doctor`'s job.
 *
 * The layout exists to answer one question fast: "what port is <name> on?".
 * The previous table spent five of its nine columns on values that were
 * identical in every row (branch mirrored name, db mode was always shared, and
 * the db/studio ports were the shared constants), which pushed the port 88
 * columns away from the name it belonged to. Those five columns are priced once
 * in the footer instead, and a dot leader carries the eye across what is left.
 */
import pc from 'picocolors';
import type { Ports } from './ports';
import { dbModeOf, type DbMode, type Registry, type SlotEntry } from './registry';
import { SHARED_SUPABASE_PORTS } from './supabase';
import { link } from './term';

export interface ListRow {
  name: string;
  slot: number;
  branch: string;
  path: string;
  createdAt: string;
  dbMode: DbMode;
  ports: Ports;
  live: boolean;
  recordedStatus: SlotEntry['status'];
}

/** Indent + status glyph + one space, before the name starts. */
const GUTTER = 4;
/** Space, at least three leader dots, space — the gap at the longest name. */
const LEADER = 5;

/**
 * The ports a worktree actually answers on.
 *
 * A shared-DB worktree still carries a slot-derived Supabase block in its
 * registry entry, but nothing ever binds it — the primary checkout's standard
 * ports are live instead. Reporting the slot block for those would send you to
 * a port with nothing on it.
 */
export function effectivePorts(row: Pick<ListRow, 'ports' | 'dbMode'>): Ports {
  if (row.dbMode === 'isolated') return row.ports;
  return { ...row.ports, ...SHARED_SUPABASE_PORTS };
}

export function buildRows(reg: Registry, live: Set<number> | null): ListRow[] {
  return Object.entries(reg.slots).map(([name, e]) => ({
    name,
    slot: e.slot,
    branch: e.branch,
    path: e.path,
    createdAt: e.createdAt,
    dbMode: dbModeOf(e),
    ports: e.ports,
    // Either port answering is enough: a stack whose web compiled but whose api
    // died is still very much running and still holding the slot.
    live: live ? live.has(e.ports.web) || live.has(e.ports.api) : e.status === 'running',
    recordedStatus: e.status,
  }));
}

/**
 * Running first, then by name.
 *
 * Slot order — what this used to sort by — is creation order, which answers
 * neither "what is running" nor "where is the one I named". Plain codepoint
 * comparison keeps the order identical across locales; names are already
 * restricted to [a-z0-9-] by sanitizeName.
 */
export function sortRows(rows: ListRow[]): ListRow[] {
  return [...rows].sort(
    (a, b) => Number(b.live) - Number(a.live) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** Case-insensitive substring match on the name, as typed. */
export function filterRows(rows: ListRow[], query: string): ListRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

export interface RailOpts {
  /** False when lsof was unavailable and status came from the registry. */
  probed: boolean;
  /** Terminal width; the api column drops when it will not fit. */
  columns?: number;
  /** Registry size, when `rows` has been filtered down from it. */
  totalCount?: number;
}

export function renderRail(rows: ListRow[], opts: RailOpts): string[] {
  if (!rows.length) return [];
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const webs = rows.map((r) => `localhost:${r.ports.web}`);
  const webW = Math.max(...webs.map((s) => s.length));
  const apiW = Math.max(...rows.map((r) => String(r.ports.api).length + 1));
  const columns = opts.columns ?? 0;
  const showApi = !columns || columns >= GUTTER + nameW + LEADER + webW + 2 + 4 + apiW;

  const lines = rows.map((r, i) => {
    const paint = r.live ? pc.green : pc.dim;
    const glyph = r.live ? pc.green('●') : pc.dim('○');
    const name = r.live ? pc.bold(r.name) : r.name;
    // At the longest name this is exactly three dots; the floor of two keeps a
    // visible rail if a future name ever exceeds the measured maximum.
    const dots = Math.max(2, nameW - r.name.length + 3);
    const leader = pc.dim(` ${'·'.repeat(dots)} `);
    const web = link(`http://localhost:${r.ports.web}`, paint(webs[i]!)) + ' '.repeat(webW - webs[i]!.length);
    const api = showApi
      ? `  ${pc.dim('api')} ${link(`http://localhost:${r.ports.api}`, pc.dim(`:${r.ports.api}`))}`
      : '';
    return `  ${glyph} ${name}${leader}${web}${api}`.trimEnd();
  });

  return [...lines, '', `  ${pc.dim(footer(rows, opts))}`];
}

function footer(rows: ListRow[], opts: RailOpts): string {
  const running = rows.filter((r) => r.live).length;
  const scope =
    opts.totalCount != null && opts.totalCount !== rows.length
      ? `${rows.length} of ${opts.totalCount} worktrees`
      : `${rows.length} ${rows.length === 1 ? 'worktree' : 'worktrees'}`;
  const parts = [scope, `${running} running`];
  // Naming the shared Supabase ports is only honest while every row uses them;
  // an isolated worktree binds its own slot-derived block instead.
  parts.push(
    rows.every((r) => r.dbMode === 'shared')
      ? `shared Supabase db :${SHARED_SUPABASE_PORTS.sbDb} studio :${SHARED_SUPABASE_PORTS.sbStudio}`
      : 'mixed DB modes — `pnpm worktree list <name>` for per-worktree ports',
  );
  if (!opts.probed) parts.push('status from registry (lsof unavailable)');
  return parts.join(' · ');
}

export function renderDetail(row: ListRow, opts: { probed: boolean }): string[] {
  const p = effectivePorts(row);
  const glyph = row.live ? pc.green('●') : pc.dim('○');
  const state = row.live ? 'running' : 'stopped';
  const drift = opts.probed && (row.recordedStatus === 'running') !== row.live
    ? pc.yellow(` (registry says ${row.recordedStatus})`)
    : '';
  const field = (label: string, href: string, text = href) =>
    `    ${pc.dim(label.padEnd(7))} ${link(href, pc.cyan(text))}`;
  const out = [
    `  ${glyph} ${pc.bold(row.name)}  ${pc.dim(`slot ${row.slot} · ${state} · ${row.dbMode} db`)}${drift}`,
    '',
    field('web', `http://localhost:${p.web}`),
    field('api', `http://localhost:${p.api}/v1`),
    field('studio', `http://localhost:${p.sbStudio}`),
  ];
  if (row.branch !== row.name) out.push(`    ${pc.dim('branch'.padEnd(7))} ${row.branch}`);
  out.push(`    ${pc.dim('path'.padEnd(7))} ${pc.dim(row.path)}`);
  return out;
}

export function toJsonRows(rows: ListRow[], opts: { probed: boolean }) {
  return rows.map((r) => {
    const p = effectivePorts(r);
    return {
      name: r.name,
      slot: r.slot,
      branch: r.branch,
      path: r.path,
      createdAt: r.createdAt,
      dbMode: r.dbMode,
      status: r.live ? 'running' : 'stopped',
      recordedStatus: r.recordedStatus,
      probed: opts.probed,
      // Only ports something actually binds. `sbAnalytics` and `sbPooler` are
      // reserved by computePorts to keep slot blocks from overlapping, but both
      // services are `enabled = false` in supabase/config.toml and
      // rewriteConfigToml only rewrites ports — so no worktree binds them in
      // either DB mode. Publishing them would invite a request to a dead port.
      ports: {
        web: p.web,
        api: p.api,
        gateway: p.gateway,
        sbApi: p.sbApi,
        sbDb: p.sbDb,
        sbStudio: p.sbStudio,
        sbInbucket: p.sbInbucket,
      },
      urls: {
        web: `http://localhost:${p.web}`,
        api: `http://localhost:${p.api}/v1`,
        studio: `http://localhost:${p.sbStudio}`,
      },
    };
  });
}
