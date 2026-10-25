import type { ApiClient } from '../api/client.ts';
import type {
  ProjectTrigger,
  TriggerEventApp,
  TriggerEventAppsResponse,
  TriggerEventType,
  TriggerEventTypesResponse,
} from '../api/types.ts';
import {
  type CtxOpts,
  emitJson,
  missing,
  resolveProjectAuth,
  resolveProjectContext,
  surfaceApiError,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

// `kortix triggers events` and the event-config helpers shared by add/set.
// The catalog (`GET …/triggers/event-types`) is the only guide to an event's
// config fields, so every message here quotes the field description.

interface SchemaProp {
  type?: unknown;
  description?: unknown;
  default?: unknown;
  enum?: unknown;
  examples?: unknown;
  items?: { type?: unknown };
}
type Schema = { properties?: Record<string, SchemaProp>; required?: unknown };

export interface ConfigField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: unknown;
  enum?: unknown[];
  example?: unknown;
}

const typeOf = (p: SchemaProp | undefined): string =>
  Array.isArray(p?.type) ? p.type.join('|') : String(p?.type ?? 'any');

/** Flatten a JSON-schema `properties` map into rows. */
export function configFields(schema: Record<string, unknown>): ConfigField[] {
  const s = schema as Schema;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  return Object.entries(s.properties ?? {}).map(([name, p]) => ({
    name,
    type: typeOf(p),
    required: required.includes(name),
    description: typeof p?.description === 'string' ? p.description : '',
    default: p?.default,
    enum: Array.isArray(p?.enum) ? p.enum : undefined,
    example: Array.isArray(p?.examples) ? p.examples[0] : undefined,
  }));
}

const describe = (f: ConfigField): string => (f.description ? ` — ${f.description}` : '');

/**
 * Coerce string values (from `--config k=v`) to the schema's type, then check
 * required fields and enums. Non-string values (from `--config-json`) are
 * already typed and stay as they are. Returns every problem at once.
 */
export function prepareConfig(
  config: Record<string, unknown>,
  schema: Record<string, unknown>,
): { config: Record<string, unknown> } | { errors: string[] } {
  const errors: string[] = [];
  const out: Record<string, unknown> = { ...config };
  const fields = configFields(schema);
  const props = (schema as Schema).properties ?? {};
  for (const f of fields) {
    const v = out[f.name];
    if (typeof v !== 'string') continue;
    if (f.type === 'number' || f.type === 'integer') {
      const n = v.trim() === '' ? Number.NaN : Number(v);
      if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) {
        errors.push(
          `${f.name} must be ${f.type === 'integer' ? 'an integer' : 'a number'} (got "${v}")${describe(f)}`,
        );
      } else out[f.name] = n;
    } else if (f.type === 'boolean') {
      if (v === 'true' || v === 'false') out[f.name] = v === 'true';
      else errors.push(`${f.name} must be true or false (got "${v}")${describe(f)}`);
    } else if (f.type === 'array') {
      const parts = v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const itemType = typeOf(props[f.name]?.items);
      const items = itemType === 'number' || itemType === 'integer' ? parts.map(Number) : parts;
      if (items.some((x) => typeof x === 'number' && !Number.isFinite(x))) {
        errors.push(
          `${f.name} must be a comma-separated list of numbers (got "${v}")${describe(f)}`,
        );
      } else out[f.name] = items;
    }
  }
  for (const f of fields) {
    const v = out[f.name];
    if (f.required && (v === undefined || v === null || v === '')) {
      errors.push(`${f.name} is required${describe(f)} (--config ${f.name}=…)`);
    } else if (f.enum && v !== undefined && !f.enum.includes(v)) {
      errors.push(`${f.name} must be one of ${f.enum.join(', ')} (got "${String(v)}")`);
    }
  }
  return errors.length > 0 ? { errors } : { config: out };
}

/** The catalog entry for one event. `null` = catalog unreachable, so the caller skips validation. */
export async function lookupEvent(
  client: ApiClient,
  projectId: string,
  connector: string,
  event: string,
): Promise<{ event: TriggerEventType } | { error: string } | null> {
  let resp: TriggerEventTypesResponse;
  try {
    resp = await client.get<TriggerEventTypesResponse>(eventTypesPath(projectId, connector));
  } catch {
    return null;
  }
  const found = resp.event_types.find((e) => e.type === event);
  return found
    ? { event: found }
    : {
        error: `Unknown event ${event} for ${connector}. Run \`kortix triggers events --connector ${connector}\`.`,
      };
}

/**
 * Coerce and validate an event trigger's config against the catalog. Local
 * mode (`ctxOpts` only, no login required) skips quietly when offline.
 */
export async function checkEventConfig(
  ctx: { client: ApiClient; projectId: string } | null,
  connector: string,
  event: string,
  config: Record<string, unknown>,
): Promise<{ config: Record<string, unknown>; eventName?: string } | { error: string }> {
  if (!ctx) return { config };
  const found = await lookupEvent(ctx.client, ctx.projectId, connector, event);
  if (!found) return { config };
  if ('error' in found) return found;
  const result = prepareConfig(config, found.event.config_schema);
  if ('errors' in result) {
    return {
      error: `Invalid config for ${event}:\n${result.errors.map((e) => `    - ${e}`).join('\n')}\n  Fields: kortix triggers events --connector ${connector} --event ${event}`,
    };
  }
  return { config: result.config, eventName: found.event.name };
}

/**
 * Print an API error for an event-trigger command. The `event_triggers` flag gate
 * (403 `feature_disabled`) gets the one actionable line; every other error is generic.
 */
export function surfaceEventTriggerError(err: unknown): number {
  const body = (err as { body?: { code?: unknown; feature?: unknown } } | null)?.body;
  if (body?.code === 'feature_disabled' && body.feature === 'event_triggers') {
    process.stderr.write(
      `${status.err('Composio event triggers are off for this project. Turn them on: kortix projects features enable event_triggers')}\n`,
    );
    return 1;
  }
  return surfaceApiError(err);
}

/** A project context for the catalog, or null when not logged in / no project (local mode stays offline-capable). */
export async function quietCatalogContext(
  opts: CtxOpts,
): Promise<{ client: ApiClient; projectId: string } | null> {
  if (!resolveProjectAuth({ hostArg: opts.hostArg }).auth?.token) return null;
  const ctx = await resolveProjectContext({ ...opts, quietWhenUnresolved: true });
  return ctx ? { client: ctx.client, projectId: ctx.projectId } : null;
}

/** Status word + the exact next step for an event trigger. */
export function eventNextStep(
  t: ProjectTrigger,
  eventName?: string,
): { word: string; lines: string[] } {
  const e = t.event;
  if (!e) return { word: '—', lines: [] };
  switch (e.status) {
    case 'active':
      return { word: 'live', lines: [`Live. It fires on the next ${eventName ?? e.type}.`] };
    case 'needs_connection':
      return {
        word: 'needs connection',
        lines: [
          // An MCP connector signs in with OAuth (`authorize`, the project's
          // default shared account); `connect` links are Composio/Pipedream only.
          (e.source ?? e.provider) === 'mcp'
            ? e.account
              ? `Needs the project-shared ${e.app ?? e.connector} account labelled "${e.account}" on ${e.connector}, signed in. A person signs in the default shared account: kortix connectors authorize ${e.connector}  (pin "${e.account}" as the default first: kortix connectors connections default <id>)`
              : `Needs a signed-in project-shared ${e.app ?? e.connector} account. A person must sign it in: kortix connectors authorize ${e.connector}`
            : e.account
              ? `Needs a project-shared ${e.app ?? e.connector} account labelled "${e.account}" on ${e.connector}. A person must open the link: kortix connectors connect ${e.connector} --owner project  (label it "${e.account}": kortix connectors connections rename <id> ${e.account})`
              : `Needs a project-shared ${e.app ?? e.connector} account. A person must open the link: kortix connectors connect ${e.connector} --owner project`,
          'It goes live when the account is connected.',
        ],
      };
    case 'error': {
      // The project flag is off: the fix is the flag, not the trigger's settings.
      if (/^(Composio|Connector|App) event triggers are off/.test(e.error ?? '')) {
        return {
          word: 'error',
          lines: [`Error: ${e.error}`, 'Turn them on: kortix projects features enable event_triggers'],
        };
      }
      // No provider: the connector is undeclared. A provider other than the
      // source: the connector cannot serve that adapter. Neither is a config fix.
      const connectorFix = !e.provider
        ? '<slug>'
        : e.source && e.source !== e.provider
          ? `<a ${e.source} connector>`
          : null;
      return {
        word: 'error',
        lines: [
          `Error: ${e.error ?? 'the provider rejected the subscription'}`,
          connectorFix
            ? `Pick a connector that serves it: kortix triggers set ${t.slug} --connector ${connectorFix}  (connectors with events: kortix triggers events --apps)`
            : `Fix the settings: kortix triggers set ${t.slug} --config <key>=<value>  (fields: kortix triggers events --connector ${e.connector} --event ${e.type})`,
        ],
      };
    }
    default:
      return {
        word: 'pending',
        lines: [`Subscribing. Check again: kortix triggers info ${t.slug}`],
      };
  }
}

const eventTypesPath = (projectId: string, connector: string): string =>
  `/projects/${projectId}/triggers/event-types?connector=${encodeURIComponent(connector)}`;

const appEventTypesPath = (projectId: string, app: string, source?: string): string =>
  `/projects/${projectId}/triggers/event-types?app=${encodeURIComponent(app)}${source ? `&source=${encodeURIComponent(source)}` : ''}`;

const eventAppsPath = (projectId: string): string => `/projects/${projectId}/triggers/event-apps`;

const sourceOf = (x: { source?: string; provider: string }): string => x.source ?? x.provider;

/** What an MCP app needs before a trigger can run on it: `steps` (may be empty), then a trigger on `connector`. */
interface McpSetup {
  connector: string;
  steps: string[];
}

const AUTHORIZE_NOTE = '  (a person signs in; the account is shared with the project)';

/**
 * The setup of one MCP app, from its `event-apps` entry. An app with a
 * connector (every project MCP server has one) only needs its account signed
 * in; a catalogue app is added from its `mcp_url` first. No entry (the
 * listing failed): the generic steps.
 */
function mcpSetup(app: string, entry: TriggerEventApp | undefined): McpSetup {
  if (entry?.connector) {
    return {
      connector: entry.connector,
      steps: entry.connected ? [] : [`kortix connectors authorize ${entry.connector}${AUTHORIZE_NOTE}`],
    };
  }
  const slug = entry?.new_connector_slug ?? app;
  return {
    connector: slug,
    steps: [
      `kortix connectors add ${slug} --provider mcp --url ${entry?.mcp_url ?? '<mcp_url from kortix triggers events --apps --json>'} --apply`,
      `kortix connectors authorize ${slug}${AUTHORIZE_NOTE}`,
    ],
  };
}

/** The only source that lists `app`, or undefined (none, several, or the listing failed). */
async function soleSourceOf(ctx: { client: ApiClient; projectId: string }, app: string): Promise<string | undefined> {
  try {
    const { apps } = await ctx.client.get<TriggerEventAppsResponse>(eventAppsPath(ctx.projectId));
    const sources = new Set(apps.filter((a) => a.app === app).map(sourceOf));
    return sources.size === 1 ? [...sources][0] : undefined;
  } catch {
    return undefined;
  }
}

async function loadMcpSetup(ctx: { client: ApiClient; projectId: string }, app: string): Promise<McpSetup> {
  let apps: TriggerEventApp[] = [];
  try {
    ({ apps } = await ctx.client.get<TriggerEventAppsResponse>(eventAppsPath(ctx.projectId)));
  } catch {
    /* the hint falls back to the generic steps */
  }
  return mcpSetup(app, apps.find((a) => a.app === app && sourceOf(a) === 'mcp'));
}

const numbered = (steps: string[]): string =>
  steps.map((s, i) => `    ${C.dim}${i + 1}.${C.reset} ${s}\n`).join('');

export async function triggersEvents(
  args: { apps: boolean; connector?: string; app?: string; source?: string; event?: string },
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!args.apps && !args.connector && !args.app) {
    return missing('--app <app> or --connector <slug> (or --apps to list event-capable apps)');
  }
  if (args.connector && args.app) return missing('only one of --app and --connector');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  try {
    if (args.apps) return await printApps(ctx, json);
    // No --source: the app's own, when the app listing names exactly one (the API's default is composio).
    const source = args.app && !args.source ? await soleSourceOf(ctx, args.app) : args.source;
    const resp = await ctx.client.get<TriggerEventTypesResponse>(
      args.app
        ? appEventTypesPath(ctx.projectId, args.app, source)
        : eventTypesPath(ctx.projectId, args.connector as string),
    );
    const via = args.app ? { app: args.app } : { connector: args.connector as string };
    // An MCP app is added from its catalogue URL, which only the app listing carries.
    const mcp = !json && args.app && sourceOf(resp) === 'mcp' ? await loadMcpSetup(ctx, args.app) : undefined;
    return args.event ? printEvent(resp, args.event, json, via, mcp) : printEvents(resp, json, via, mcp);
  } catch (err) {
    return surfaceEventTriggerError(err);
  }
}

async function printApps(
  ctx: { client: ApiClient; projectId: string },
  json: boolean,
): Promise<number> {
  const resp = await ctx.client.get<TriggerEventAppsResponse>(eventAppsPath(ctx.projectId));
  if (json) {
    emitJson(resp);
    return 0;
  }
  if (resp.apps.length === 0) {
    process.stdout.write(`  ${C.dim}No app can trigger events on this deployment.${C.reset}\n`);
    return 0;
  }
  const out = process.stdout;
  out.write('\n');
  const withConnector = resp.apps
    .filter((a) => (a.connectors?.length ?? 0) > 0)
    .sort((a, b) => sourceOf(a).localeCompare(sourceOf(b)));
  let lastSource = '';
  for (const a of withConnector) {
    const source = sourceOf(a);
    if (source !== lastSource) {
      out.write(`${lastSource ? '\n' : ''}  ${C.dim}source: ${source}${C.reset}\n`);
      lastSource = source;
    }
    const state = a.connected
      ? `${C.green}connected${C.reset}`
      : `${C.yellow}needs account${C.reset}`;
    out.write(
      `  ${C.bold}${a.app}${C.reset}  ${C.dim}${a.event_count} event${a.event_count === 1 ? '' : 's'}${C.reset}  ${state}\n`,
    );
    for (const c of a.connectors ?? []) {
      out.write(
        `    ${C.cyan}${c.slug}${C.reset}${c.accounts.length === 0 ? `  ${C.yellow}no shared account${C.reset}` : ''}\n`,
      );
      const labelW = Math.max(...c.accounts.map((x) => x.label.length), 5);
      for (const x of c.accounts) {
        const as = x.connected_as ? `as ${x.connected_as}` : '';
        const flags = [x.is_default ? 'default' : '', x.connected ? '' : 'not connected']
          .filter(Boolean)
          .join(', ');
        out.write(`      ${pad(x.label, labelW)}  ${pad(as, 24)} ${C.faded}${flags}${C.reset}\n`);
      }
    }
  }
  const rest = resp.apps.filter((a) => (a.connectors?.length ?? 0) === 0);
  const restSources = [...new Set(rest.map(sourceOf))].sort();
  for (const source of restSources) {
    const apps = rest.filter((a) => sourceOf(a) === source);
    out.write(
      `\n  ${C.dim}No connector yet, source ${source} (${apps.length}): ${apps.map((a) => `${a.app} (${a.event_count}${a.new_connector_slug && a.new_connector_slug !== a.app ? `, add as ${a.new_connector_slug}` : ''})`).join(', ')}${C.reset}\n`,
    );
  }
  // Each source adds a connector its own way. Composio apps are listed only
  // where a connector exists, so its add line shows only when one is missing.
  const addLines = [
    ...(restSources.includes('composio')
      ? ['Add a connector: kortix connectors add <slug> --provider composio --app <app> --apply']
      : []),
    ...(restSources.includes('mcp')
      ? ["Add an MCP app (its read-only list tools become events too): kortix connectors add <slug> --provider mcp --url <mcp_url> --apply, then sign it in for the project: kortix connectors authorize <slug>. One app's exact commands: kortix triggers events --app <app>."]
      : []),
  ];
  out.write(
    `\n  ${C.dim}${resp.apps.length} apps. List an app's events (no connector needed): kortix triggers events --app <app>. A connector's: --connector <slug>.\n${addLines.map((l) => `  ${l}\n`).join('')}  Pick an account: kortix triggers add … --connector <slug> --account <label> (omit it for the default).\n  See every app event trigger: kortix triggers ls --type event  (one connector: kortix triggers ls --connector <slug>).${C.reset}\n\n`,
  );
  return 0;
}

type EventsVia = { connector: string } | { app: string };
const viaFlag = (via: EventsVia): string => ('app' in via ? `--app ${via.app}` : `--connector ${via.connector}`);

function printEvents(
  resp: TriggerEventTypesResponse,
  json: boolean,
  via: EventsVia,
  mcp?: McpSetup,
): number {
  if (json) {
    emitJson(resp);
    return 0;
  }
  if (resp.event_types.length === 0) {
    process.stdout.write(
      mcp?.steps.length
        ? `  ${C.dim}${resp.app} has no event types yet. Its read-only list tools become events after these steps:${C.reset}\n${numbered(mcp.steps)}`
        : `  ${C.dim}${resp.app} has no event types.${C.reset}\n`,
    );
    return 0;
  }
  const typeW = Math.max(...resp.event_types.map((e) => e.type.length), 4);
  const nameW = Math.max(...resp.event_types.map((e) => e.name.length), 4);
  process.stdout.write(
    `\n  ${C.dim}${pad('TYPE', typeW)}   ${pad('NAME', nameW)}   DELIVERY${C.reset}\n`,
  );
  for (const e of resp.event_types) {
    process.stdout.write(
      `  ${pad(e.type, typeW)}   ${pad(e.name, nameW)}   ${C.faded}${e.delivery ?? '—'}${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${resp.event_types.length} event type${resp.event_types.length === 1 ? '' : 's'} on ${resp.app} (${sourceOf(resp)}). Details: kortix triggers events ${viaFlag(via)} --event <TYPE>${C.reset}\n` +
      (mcp?.steps.length ? `  ${C.dim}Set it up first:${C.reset}\n${numbered(mcp.steps)}` : '') +
      '\n',
  );
  return 0;
}

function printEvent(
  resp: TriggerEventTypesResponse,
  type: string,
  json: boolean,
  via: EventsVia,
  mcp?: McpSetup,
): number {
  const e = resp.event_types.find((x) => x.type === type);
  if (!e) {
    process.stderr.write(
      `${status.err(`Unknown event ${type} for ${resp.app}. Run \`kortix triggers events ${viaFlag(via)}\`.`)}\n`,
    );
    return 1;
  }
  if (json) {
    emitJson(e);
    return 0;
  }
  const out = process.stdout;
  out.write(`\n  ${C.bold}${e.type}${C.reset}  ${e.name}\n`);
  if (e.description)
    out.write(`  ${C.dim}${e.description.replace(/\s+/g, ' ').trim()}${C.reset}\n`);
  out.write(`  ${C.dim}delivery${C.reset} ${e.delivery ?? 'unknown'}\n`);
  const fields = configFields(e.config_schema);
  out.write(`\n  ${C.dim}Config (--config <key>=<value>)${C.reset}\n`);
  if (fields.length === 0) out.write('    none\n');
  for (const f of fields) {
    const meta = [
      f.type,
      f.required ? 'required' : 'optional',
      ...(f.default !== undefined ? [`default ${JSON.stringify(f.default)}`] : []),
      ...(f.enum ? [`one of ${f.enum.join(', ')}`] : []),
      ...(f.example !== undefined ? [`e.g. ${JSON.stringify(f.example)}`] : []),
    ].join(', ');
    out.write(`    ${C.cyan}${f.name}${C.reset} (${meta})${describe(f)}\n`);
  }
  out.write(`\n  ${C.dim}Prompt variables${C.reset}\n`);
  out.write(
    '    {{ event.id }} {{ event.type }} {{ event.app }} {{ event.connector }} {{ event.occurred_at }}\n',
  );
  const payload = Object.entries(((e.payload_schema ?? {}) as Schema).properties ?? {});
  for (const [name, p] of payload) {
    out.write(
      `    {{ event.data.${name} }}${typeof p?.description === 'string' ? ` — ${p.description}` : ''}\n`,
    );
  }
  if (payload.length === 0) out.write('    {{ event.data.<field> }} — the provider payload\n');
  const addTrigger = (connector: string) =>
    `kortix triggers add <slug> --type event --connector ${connector} --event ${e.type} --prompt "…" --apply`;
  out.write(
    mcp
      ? mcp.steps.length
        ? `\n  ${C.dim}Add it:${C.reset}\n${numbered([...mcp.steps, addTrigger(mcp.connector)])}\n`
        : `\n  ${C.dim}Add it: ${addTrigger(mcp.connector)}${C.reset}\n\n`
      : 'app' in via
        ? `\n  ${C.dim}Add it: kortix connectors add <slug> --provider composio --app ${via.app} --apply, then ${addTrigger('<slug>')}${C.reset}\n\n`
        : `\n  ${C.dim}Add it: ${addTrigger(via.connector)}${C.reset}\n\n`,
  );
  return 0;
}
