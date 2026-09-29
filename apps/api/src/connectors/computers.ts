/**
 * Computer connectors — machines reached over the Agent Computer Tunnel, as a
 * first-class connector with a FIXED, hand-curated catalog (the tunnel RPC
 * method set).
 *
 * A paired machine is an ACCOUNT on the project's `computer` connector: one
 * `connector_connections` row whose `tunnel_id` names the machine, owned by
 * one member (private) or by the project (shared). The generic connection
 * resolver picks the account (`--account`, session bindings, reachability);
 * the gateway relays through the shared tunnel RPC core
 * (`tunnel/core/rpc-core.ts`), NOT executeCall.
 */
import { connectorActions, connectorConnections, connectors } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../shared/db';
import type { ActionBinding, NormalizedAction, Risk } from './types';

/** Default name of a project's computer connector. */
export const COMPUTER_CONNECTOR_NAME = 'Computers';

/** The one computer connector slug per project. */
export const COMPUTER_SLUG = 'computer';

/** One curated computer action — normalized into a `tunnel`-bound NormalizedAction. */
interface ComputerActionDef {
  /** Connector-relative tool path (the connector namespace tail, e.g. `fs.read`). */
  path: string;
  /** Tunnel RPC method relayed to the machine (usually identical to `path`). */
  method: string;
  name: string;
  description: string;
  risk: Risk;
  /** JSON-schema properties for the operation itself. */
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/**
 * The computer catalog. `fs.*` + `shell.exec` are fully typed; the high-value
 * `desktop.cua.*` methods are typed too, and `desktop.cua.call` is a generic
 * passthrough to ANY of the ~45 desktop methods (like Pipedream's `request`), so
 * the long tail is reachable without hand-maintaining every schema.
 */
const COMPUTER_ACTIONS: ComputerActionDef[] = [
  {
    path: 'status',
    method: 'status',
    name: 'Computer status',
    description:
      'Call this first. Shows the computer this call resolves to: name, online status, platform, approved capabilities, home_dir, and allowed_paths (file tools only work inside these). Select another computer with the account flag.',
    risk: 'read',
    properties: {},
    required: [],
  },
  // ── filesystem ──────────────────────────────────────────────────────────
  {
    path: 'fs.read',
    method: 'fs.read',
    name: 'Read file',
    description: 'Read a file from the machine. Provide an absolute `path`.',
    risk: 'read',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path of the file to read.',
      },
      encoding: {
        type: 'string',
        description: 'Encoding: "utf-8" (default) or "base64" for binary.',
      },
    },
    required: ['path'],
  },
  {
    path: 'fs.write',
    method: 'fs.write',
    name: 'Write file',
    description: 'Write (create or overwrite) a file on the machine. Never transcribe binary base64 from tool output. Use agent-tunnel-cli fs_upload with a local source path, or generate the artifact on the destination. For programmatic binary writes, supply the source SHA-256. The result includes the persisted sha256; size alone does not prove integrity.',
    risk: 'write',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path of the file to write.',
      },
      content: { type: 'string', description: 'File contents. Pass binary bytes programmatically, never through model transcription.' },
      sha256: { type: 'string', description: 'Optional SHA-256 of the source bytes. A mismatch rejects the write before modifying the destination.' },
      encoding: {
        type: 'string',
        description: 'Encoding of `content`: "utf-8" (default) or "base64".',
      },
    },
    required: ['path', 'content'],
  },
  {
    path: 'fs.list',
    method: 'fs.list',
    name: 'List directory',
    description:
      'List the entries of a directory on the machine. Provide `path`; set `recursive` to walk subdirectories.',
    risk: 'read',
    properties: {
      path: { type: 'string', description: 'Absolute directory path to list.' },
      recursive: {
        type: 'boolean',
        description: 'Recurse into subdirectories (default false).',
      },
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
    description:
      'Delete a file or directory on the machine. Destructive — confirm intent. Provide `path`.',
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
    name: 'Run executable',
    description:
      'Run one executable directly and return stdout/stderr/exitCode. No shell parses the command. Pass arguments through `args`; use `sh -c` or the platform equivalent only when shell syntax or built-ins are required. Be deliberate — executables can be destructive.',
    risk: 'write',
    properties: {
      command: {
        type: 'string',
        description: 'The executable name or path. Shell built-ins are not executables.',
      },
      args: { type: 'array', description: 'Optional argument list.' },
      cwd: { type: 'string', description: 'Optional working directory.' },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds.',
      },
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
    description:
      'Read the accessibility tree of the focused window — the elements you can interact with.',
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
      keys: {
        type: 'array',
        description: 'Keys to press together, e.g. ["cmd","c"].',
      },
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
      tool: {
        type: 'string',
        description: 'Computer-use tool name (e.g. "double_click", "drag", "zoom").',
      },
      args: { type: 'object', description: 'Arguments for the tool.' },
    },
    required: ['tool'],
  },
];

function toAction(def: ComputerActionDef): NormalizedAction {
  const binding: ActionBinding = { kind: 'tunnel', method: def.method };
  const inputSchema = Object.keys(def.properties).length
    ? {
        type: 'object',
        properties: def.properties,
        ...(def.required.length ? { required: def.required } : {}),
      }
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

/** The fixed catalog of every computer connector. */
export function computerCatalog(): NormalizedAction[] {
  return COMPUTER_ACTIONS.map(toAction);
}

type ActionRow = typeof connectorActions.$inferSelect;

/**
 * Computer actions always come from this code, never from `connector_actions`.
 * An older API (a replica mid-rollout, or an old stack sharing the database)
 * re-materializes its own catalog into that table, and an agent reading it
 * then calls tools that no longer exist.
 */
export function withComputerCatalog(
  connectorId: string,
  providerType: string | null | undefined,
  stored: ActionRow[],
): ActionRow[] {
  if (providerType !== 'computer') return stored;
  const epoch = new Date(0);
  return computerCatalog().map((action) => ({
    actionId: `computer:${action.path}`,
    connectorId,
    path: action.path,
    name: action.name,
    description: action.description ?? null,
    inputSchema: (action.inputSchema ?? null) as Record<string, unknown> | null,
    outputSchema: null,
    risk: action.risk,
    binding: (action.binding ?? {}) as Record<string, unknown>,
    createdAt: epoch,
    updatedAt: epoch,
  }));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ConnectionRow = typeof connectorConnections.$inferSelect;

/** `name`, or `name (2)`, `name (3)`, … — the first label this owner does not hold. */
export function uniqueComputerLabel(name: string, taken: ReadonlySet<string>): string {
  const base = name.trim().slice(0, 240) || 'Computer';
  const lower = new Set([...taken].map((label) => label.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Make one paired machine an account on a project's computer connector.
 *
 * Idempotent on (connector, owner, machine): the existing account is returned
 * (and reactivated when it was revoked). A revoked account of the same owner
 * that lost its machine and carries the machine's name is reused, so re-pairing
 * a computer keeps its label and every session binding to it. Otherwise a new
 * account is created with a unique label; it becomes the owner's default when
 * the owner has none.
 *
 * Attaches to one connector serialize on its row lock, so two concurrent
 * approvals for the same owner cannot both pin a default or pick one label.
 */
export async function attachComputerConnection(
  tx: Tx,
  input: {
    accountId: string;
    projectId: string;
    connectorId: string;
    ownerType: 'member' | 'project';
    /** The member's user id; null for a project-shared account. */
    ownerId: string | null;
    tunnelId: string;
    name: string;
    createdBy: string;
  },
): Promise<{ connection: ConnectionRow; created: boolean }> {
  const owner = and(
    eq(connectorConnections.connectorId, input.connectorId),
    eq(connectorConnections.ownerType, input.ownerType),
    input.ownerId === null
      ? isNull(connectorConnections.ownerId)
      : eq(connectorConnections.ownerId, input.ownerId),
  );
  await tx
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(eq(connectors.connectorId, input.connectorId))
    .for('update');
  const rows = await tx.select().from(connectorConnections).where(owner);
  const hasDefault = rows.some((row) => row.isDefault);
  const reactivate = async (row: ConnectionRow) => {
    const [updated] = await tx
      .update(connectorConnections)
      .set({
        tunnelId: input.tunnelId,
        status: 'active',
        ...(hasDefault ? {} : { isDefault: true }),
        updatedAt: new Date(),
      })
      .where(eq(connectorConnections.connectionId, row.connectionId))
      .returning();
    return { connection: updated!, created: false };
  };

  const same = rows.find((row) => row.tunnelId === input.tunnelId);
  if (same) return same.status === 'active' ? { connection: same, created: false } : reactivate(same);
  const orphan = rows.find(
    (row) =>
      row.tunnelId === null &&
      row.status === 'revoked' &&
      row.label.toLowerCase() === input.name.trim().toLowerCase(),
  );
  if (orphan) return reactivate(orphan);

  const [created] = await tx
    .insert(connectorConnections)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      connectorId: input.connectorId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      label: uniqueComputerLabel(input.name, new Set(rows.map((row) => row.label))),
      status: 'active',
      isDefault: !hasDefault,
      tunnelId: input.tunnelId,
      createdBy: input.createdBy,
    })
    .returning();
  return { connection: created!, created: true };
}

