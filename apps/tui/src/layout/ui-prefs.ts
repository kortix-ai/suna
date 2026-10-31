/**
 * The TUI's layout as data: which regions draw, and on which side.
 *
 * The TUI is one session and one input. Everything else is a module you turn
 * on: the header (the title row), the session tabs, the sidebar, the info
 * panel, and the tray under the input. They start off — only the tray is on,
 * because it is one row and carries the model — and `/ui` (or the first-run
 * picker) turns them on and moves them. The choice lives in `tui.json`.
 *
 * Pure: `app.tsx` reads `UiPrefs` and composes the frame from it; the `/ui`
 * panel edits it. `ui-prefs.test.ts` asserts the defaults, presets and the
 * migration from the old `{ sidebar: boolean }` file.
 */

export type ModuleId = 'header' | 'tabs' | 'sidebar' | 'info' | 'tray' | 'title';
export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface ModuleState {
  on: boolean;
  /** Where it docks. Only modules with `sides` in `MODULES` use it. */
  side?: Side;
}

export type UiPrefs = Record<ModuleId, ModuleState>;

export interface ModuleSpec {
  id: ModuleId;
  label: string;
  description: string;
  /** The sides it can dock on, first = default. None: it has one place. */
  sides?: readonly Side[];
  /** The slash command that toggles it. */
  command: string;
  /** Opt-in and still settling: `/ui` marks it, no preset but Full turns it on. */
  experimental?: boolean;
}

export const MODULES: readonly ModuleSpec[] = [
  {
    id: 'header',
    label: 'Header',
    description: 'The session title and its state, above the transcript.',
    command: 'header',
  },
  {
    id: 'tabs',
    label: 'Session tabs',
    description: 'The sessions you opened, as tabs. Alt+[ and Alt+] switch.',
    sides: ['top', 'bottom'],
    command: 'tabs',
    experimental: true,
  },
  {
    id: 'sidebar',
    label: 'Sidebar',
    description: 'Projects, every screen, and the session list.',
    sides: ['left', 'right'],
    command: 'sidebar',
  },
  {
    id: 'info',
    label: 'Info panel',
    description: 'Title, context use, model, agent, ports of the open session.',
    sides: ['right', 'left'],
    command: 'info',
    experimental: true,
  },
  {
    id: 'tray',
    label: 'Tray',
    description: 'One row under the input: where you are, model, agent, context used.',
    command: 'tray',
  },
  {
    id: 'title',
    label: 'Terminal title',
    description: "The terminal window's title follows the open session.",
    command: 'title',
  },
] as const;

/**
 * First start: the chat, its title row and the tray. The title says which
 * session this is; the tray says where, which model and agent, and how full
 * the context is. Everything else is opt-in.
 */
export const DEFAULT_UI: UiPrefs = {
  header: { on: true },
  tabs: { on: false, side: 'top' },
  sidebar: { on: false, side: 'left' },
  info: { on: false, side: 'right' },
  tray: { on: true },
  title: { on: true },
};

export interface Preset {
  id: 'minimal' | 'sidebar' | 'full';
  label: string;
  description: string;
  ui: UiPrefs;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'The chat, its title and the tray. Everything else is a slash command.',
    ui: DEFAULT_UI,
  },
  {
    id: 'sidebar',
    label: 'Sidebar',
    description: 'Plus projects, screens and sessions on the left.',
    ui: { ...DEFAULT_UI, sidebar: { on: true, side: 'left' } },
  },
  {
    id: 'full',
    label: 'Full (experimental)',
    description: 'Plus session tabs on top and the info panel on the right.',
    ui: {
      ...DEFAULT_UI,
      tabs: { on: true, side: 'top' },
      sidebar: { on: true, side: 'left' },
      info: { on: true, side: 'right' },
    },
  },
];

function isSide(value: unknown): value is Side {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom';
}

/**
 * Read a stored layout, field by field. Anything missing or malformed is the
 * default; a side a module cannot take is its first side. `legacySidebar` is
 * the old `tui.json` `{ "sidebar": true }`, honoured when `ui` is absent.
 */
export function normalizeUi(raw: unknown, legacySidebar?: boolean): UiPrefs {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as UiPrefs;
  for (const spec of MODULES) {
    const base = DEFAULT_UI[spec.id];
    const entry = (
      source[spec.id] && typeof source[spec.id] === 'object' ? source[spec.id] : {}
    ) as Record<string, unknown>;
    const on = typeof entry.on === 'boolean' ? entry.on : base.on;
    const side =
      spec.sides && isSide(entry.side) && spec.sides.includes(entry.side) ? entry.side : base.side;
    out[spec.id] = side ? { on, side } : { on };
  }
  if (!raw && typeof legacySidebar === 'boolean')
    out.sidebar = { ...out.sidebar, on: legacySidebar };
  return out;
}

/** Flip one module on or off. */
export function toggleModule(ui: UiPrefs, id: ModuleId): UiPrefs {
  return { ...ui, [id]: { ...ui[id], on: !ui[id].on } };
}

/** Move a module to its next side (left ↔ right, top ↔ bottom). No sides: unchanged. */
export function cycleSide(ui: UiPrefs, id: ModuleId): UiPrefs {
  const spec = MODULES.find((entry) => entry.id === id);
  if (!spec?.sides) return ui;
  const index = spec.sides.indexOf(ui[id].side ?? spec.sides[0] ?? 'left');
  const side = spec.sides[(index + 1) % spec.sides.length];
  return { ...ui, [id]: { ...ui[id], side } };
}

/** The preset this layout equals, if any: the `/ui` panel marks it. */
export function matchingPreset(ui: UiPrefs): Preset['id'] | null {
  for (const preset of PRESETS) {
    const same = MODULES.every(
      (spec) =>
        preset.ui[spec.id].on === ui[spec.id].on &&
        (!ui[spec.id].on || !spec.sides || preset.ui[spec.id].side === ui[spec.id].side),
    );
    if (same) return preset.id;
  }
  return null;
}
