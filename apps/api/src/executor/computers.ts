/**
 * Computer connectors — connected machines reached over the Agent Computer
 * Tunnel, as a first-class Executor connector. Like `channel`, this is a
 * provider with a FIXED, hand-curated catalog (the tunnel RPC method set) rather
 * than a spec-driven one. Unlike every other provider it has NO credential — the
 * live WS relay IS the credential, and per-machine auth/scope is enforced by the
 * tunnel permission layer at call time.
 *
 * ONE `computer` connector fronts ALL of an account's machines: every action
 * takes a `computer` selector (machine name or id; optional when exactly one is
 * online), and the meta `list_computers` action enumerates them. The gateway
 * routes `tunnel` bindings through the shared tunnel RPC core
 * (`tunnel/core/rpc-core.ts`), NOT executeCall. See
 * docs/specs/computer-connector.md.
 */
import type { ActionBinding, NormalizedAction, Risk } from './types';

/** Human label for the computer connector (UI default name). */
export function computerLabel(): string {
  return 'Computers';
}

/** The slug of the single auto-materialized computer connector. */
export const COMPUTER_SLUG = 'computer';

/** One curated computer action — normalized into a `tunnel`-bound NormalizedAction. */
interface ComputerActionDef {
  /** Connector-relative tool path (the executor namespace tail, e.g. `fs.read`). */
  path: string;
  /** Tunnel RPC method relayed to the machine (usually identical to `path`). */
  method: string;
  name: string;
  description: string;
  risk: Risk;
  /** JSON-schema properties (the machine `computer` selector is added separately). */
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  /** Meta actions (list_computers) are handled server-side and take no selector. */
  meta?: boolean;
}

/** Selector shared by every relayed action — which machine to target. */
const COMPUTER_SELECTOR = {
  computer: {
    type: 'string',
    description:
      'Target machine — its name or id from list_computers. Optional when exactly one machine is online (it is used by default).',
  },
} as const;

/**
 * The computer catalog. `fs.*` + `shell.exec` are fully typed; the high-value
 * `desktop.cua.*` methods are typed too, and `desktop.cua.call` is a generic
 * passthrough to ANY of the ~45 desktop methods (like Pipedream's `request`), so
 * the long tail is reachable without hand-maintaining every schema.
 */
const COMPUTER_ACTIONS: ComputerActionDef[] = [
  {
    path: 'list_computers',
    method: 'list_computers',
    name: 'List computers',
    description:
      'List the machines connected to this account over the tunnel — id, name, online status, declared capabilities, platform. Use this to choose a `computer` for the other actions.',
    risk: 'read',
    properties: {},
    required: [],
    meta: true,
  },
  // ── filesystem ──────────────────────────────────────────────────────────
  {
    path: 'fs.read',
    method: 'fs.read',
    name: 'Read file',
    description: 'Read a file from the machine. Provide an absolute `path`.',
    risk: 'read',
    properties: {
      path: { type: 'string', description: 'Absolute path of the file to read.' },
      encoding: { type: 'string', description: 'Encoding: "utf-8" (default) or "base64" for binary.' },
    },
    required: ['path'],
  },
  {
    path: 'fs.write',
    method: 'fs.write',
    name: 'Write file',
    description: 'Write (create or overwrite) a file on the machine. Provide `path` and `content`.',
    risk: 'write',
    properties: {
      path: { type: 'string', description: 'Absolute path of the file to write.' },
      content: { type: 'string', description: 'File contents.' },
      encoding: { type: 'string', description: 'Encoding of `content`: "utf-8" (default) or "base64".' },
    },
    required: ['path', 'content'],
  },
  {
    path: 'fs.list',
    method: 'fs.list',
    name: 'List directory',
    description: 'List the entries of a directory on the machine. Provide `path`; set `recursive` to walk subdirectories.',
    risk: 'read',
    properties: {
      path: { type: 'string', description: 'Absolute directory path to list.' },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
    },
    required: ['path'],
  },
  {
    path: 'fs.stat',
    method: 'fs.stat',
    name: 'Stat path',
    description: 'Get metadata (size, type, timestamps) for a path on the machine. Provide `path`.',
    risk: 'read',
    properties: {
      path: { type: 'string', description: 'Absolute path to stat.' },
    },
    required: ['path'],
  },
  {
    path: 'fs.delete',
    method: 'fs.delete',
    name: 'Delete path',
    description: 'Delete a file or directory on the machine. Destructive — confirm intent. Provide `path`.',
    risk: 'destructive',
    properties: {
      path: { type: 'string', description: 'Absolute path to delete.' },
    },
    required: ['path'],
  },
  // ── shell ───────────────────────────────────────────────────────────────
  {
    path: 'shell.exec',
    method: 'shell.exec',
    name: 'Run shell command',
    description:
      'Run a shell command on the machine and return stdout/stderr/exitCode. Provide `command` (and optional `args`, `cwd`, `timeout`). Be deliberate — commands can be destructive.',
    risk: 'write',
    properties: {
      command: { type: 'string', description: 'The command (executable) to run.' },
      args: { type: 'array', description: 'Optional argument list.' },
      cwd: { type: 'string', description: 'Optional working directory.' },
      timeout: { type: 'number', description: 'Optional timeout in milliseconds.' },
    },
    required: ['command'],
  },
  // ── desktop (computer use) — curated; desktop.cua.call covers the long tail ─
  {
    path: 'desktop.cua.get_screen_size',
    method: 'desktop.cua.get_screen_size',
    name: 'Get screen size',
    description: 'Return the display resolution of the machine.',
    risk: 'read',
    properties: {},
    required: [],
  },
  {
    path: 'desktop.cua.list_apps',
    method: 'desktop.cua.list_apps',
    name: 'List apps',
    description: 'List running/installed applications on the machine.',
    risk: 'read',
    properties: {},
    required: [],
  },
  {
    path: 'desktop.cua.list_windows',
    method: 'desktop.cua.list_windows',
    name: 'List windows',
    description: 'List open windows on the machine.',
    risk: 'read',
    properties: {},
    required: [],
  },
  {
    path: 'desktop.cua.get_accessibility_tree',
    method: 'desktop.cua.get_accessibility_tree',
    name: 'Get accessibility tree',
    description: 'Read the accessibility tree of the focused window — the elements you can interact with.',
    risk: 'read',
    properties: {},
    required: [],
  },
  {
    path: 'desktop.cua.launch_app',
    method: 'desktop.cua.launch_app',
    name: 'Launch app',
    description: 'Launch an application on the machine. Provide the app `name`.',
    risk: 'write',
    properties: {
      name: { type: 'string', description: 'Application name to launch.' },
    },
    required: ['name'],
  },
  {
    path: 'desktop.cua.click',
    method: 'desktop.cua.click',
    name: 'Click',
    description: 'Click at a screen coordinate. Provide `x` and `y`.',
    risk: 'write',
    properties: {
      x: { type: 'number', description: 'X coordinate.' },
      y: { type: 'number', description: 'Y coordinate.' },
    },
    required: ['x', 'y'],
  },
  {
    path: 'desktop.cua.type_text',
    method: 'desktop.cua.type_text',
    name: 'Type text',
    description: 'Type text on the machine. Provide `text`.',
    risk: 'write',
    properties: {
      text: { type: 'string', description: 'Text to type.' },
    },
    required: ['text'],
  },
  {
    path: 'desktop.cua.press_key',
    method: 'desktop.cua.press_key',
    name: 'Press key',
    description: 'Press a single key. Provide `key` (e.g. "Enter", "Escape").',
    risk: 'write',
    properties: {
      key: { type: 'string', description: 'Key name to press.' },
    },
    required: ['key'],
  },
  {
    path: 'desktop.cua.hotkey',
    method: 'desktop.cua.hotkey',
    name: 'Hotkey',
    description: 'Press a key combination. Provide `keys` (e.g. ["cmd","c"]).',
    risk: 'write',
    properties: {
      keys: { type: 'array', description: 'Keys to press together, e.g. ["cmd","c"].' },
    },
    required: ['keys'],
  },
  {
    path: 'desktop.cua.scroll',
    method: 'desktop.cua.scroll',
    name: 'Scroll',
    description: 'Scroll the screen. Provide `dx`/`dy` deltas.',
    risk: 'write',
    properties: {
      dx: { type: 'number', description: 'Horizontal scroll delta.' },
      dy: { type: 'number', description: 'Vertical scroll delta.' },
    },
    required: [],
  },
  {
    path: 'desktop.cua.call',
    method: 'desktop.cua.call',
    name: 'Call any desktop tool',
    description:
      'Escape hatch — invoke ANY computer-use tool by name (use desktop.cua.list_tools / desktop.cua.describe to discover them). Provide `tool` and its `args`.',
    risk: 'write',
    properties: {
      tool: { type: 'string', description: 'Computer-use tool name (e.g. "double_click", "drag", "zoom").' },
      args: { type: 'object', description: 'Arguments for the tool.' },
    },
    required: ['tool'],
  },
];

function toAction(def: ComputerActionDef): NormalizedAction {
  const binding: ActionBinding = { kind: 'tunnel', method: def.method };
  const properties = def.meta ? def.properties : { ...COMPUTER_SELECTOR, ...def.properties };
  const inputSchema = Object.keys(properties).length
    ? { type: 'object', properties, ...(def.required.length ? { required: def.required } : {}) }
    : null;
  return {
    path: def.path,
    name: def.name,
    description: def.description,
    inputSchema,
    outputSchema: null,
    risk: def.risk,
    binding,
  };
}

/** The fixed catalog for the computer connector (identical for every account). */
export function computerCatalog(): NormalizedAction[] {
  return COMPUTER_ACTIONS.map(toAction);
}
