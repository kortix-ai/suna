import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { resolveMemberId } from './grants.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';

// A space is a named container inside a project: it groups sessions and
// owns scheduled work — see docs/specs/2026-09-03-spaces.md §2, §6 and the
// 2026-09-07 simplification. Its `spaces.<slug>` block in `kortix.yaml` is
// the source of truth; every write here commits to that file.

/** Wire shape — SpaceSchema in @kortix/api-contract. */
export interface Space {
  slug: string;
  name: string;
  description: string | null;
  agent: string | null;
  sessions: 'private' | 'shared';
  path: string;
  session_count: number;
  trigger_count: number;
  can_manage: boolean;
}

interface SpacesListResponse {
  spaces: Space[];
  errors: Array<{ slug: string; path: string; error: string }>;
}

/** One row of `GET /projects/:id/resource-grants` — locally typed rather than
 *  widening grants.ts's agent/skill/secret-only union, since only the fields
 *  used to find a space grant to revoke matter here. */
interface ResourceGrantRow {
  grant_id: string;
  resource_type: string;
  resource_id: string;
  principal_type: 'member' | 'group';
  principal_id: string;
  principal_label?: string;
  expires_at: string | null;
}
interface ResourceGrantsResponse {
  grants: ResourceGrantRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSIONS_MODES = ['private', 'shared'] as const;

const HELP = help`Usage: kortix spaces <subcommand> [options]

A space groups sessions under a named effort inside the project, with its
own default agent and scheduled work. Its \`spaces.<slug>\` block in
\`kortix.yaml\` is the source of truth — every write below commits to it.

Subcommands:
  ls [--json]                     List spaces you can see.
  show <slug> [--json]            Show one space in full.
  create <name> [options]         Declare a new space.
  update <slug> [options]         Change fields on an existing space.
  rm <slug> [--yes]               Delete a space. Sessions keep their
                                  history but lose the grouping; scheduled
                                  triggers naming it are un-scoped, not deleted.
  grant <slug> (--member <id|email> | --group <id>) [--expires YYYY-MM-DD]
                                  Let a member or group use this space.
  revoke <slug> (--member <id|email> | --group <id>)
                                  Remove that grant.

Create/update options:
  --slug <s>            Explicit slug (create only; defaults to slugify(name)).
  --name <text>          Display name (update only — \`create <name>\` is positional).
  --description <text>
  --agent <name>         Default agent for sessions started in it.
  --sessions private|shared
                         private (default): a session is visible to its
                         creator only. shared: every session in it is visible
                         to everyone granted the space.

On \`update\`, an empty value (\`--description=\`, \`--agent=\`) clears that
field. \`name\` cannot be cleared.

Global:
  --project <id>     Operate on this project id (default: linked).
  --host <name>       Operate against a non-default Kortix host.
  --json               Machine-readable output.
  -h, --help           Show this help.

Create/update/rm/grant/revoke need \`project.customize.write\`.
`;

type ProjectCtx = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>;

export async function runSpaces(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const f: Record<string, string | undefined> = {};
  let json = false;
  let yes = false;
  try {
    json = takeFlagBool(rest, ['--json']);
    yes = takeFlagBool(rest, ['--yes', '-y']);
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.slug = takeFlagValue(rest, ['--slug']);
    f.name = takeFlagValue(rest, ['--name']);
    f.description = takeFlagValue(rest, ['--description']);
    f.agent = takeFlagValue(rest, ['--agent']);
    f.sessions = takeFlagValue(rest, ['--sessions']);
    f.member = takeFlagValue(rest, ['--member']);
    f.group = takeFlagValue(rest, ['--group']);
    f.expires = takeFlagValue(rest, ['--expires']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/spaces`;

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return spacesLs(ctx, base, json);
      case 'show':
      case 'info':
        return spacesShow(ctx, base, positional[0], json);
      case 'create':
        return spacesCreate(ctx, base, positional[0], f, json);
      case 'update':
      case 'set':
        return spacesUpdate(ctx, base, positional[0], f, json);
      case 'rm':
      case 'remove':
      case 'delete':
        return spacesRm(ctx, base, positional[0], yes, json);
      case 'grant':
        return spacesGrant(ctx, positional[0], f, json);
      case 'revoke':
        return spacesRevoke(ctx, positional[0], f, json);
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

// ── read fields → sent value ────────────────────────────────────────────────
//
// `--field=` (empty via the `=` form) is the CLI's clear-a-field convention:
// undefined = "not passed, leave alone"; '' = "clear it" (sent as `null`);
// anything else = the new value. Pure, so it's unit-testable without a client.

/** `undefined` (omit), `null` (clear), or a string value — for a PATCH body. */
type FieldPatch = undefined | null | string;

export function resolveOptionalField(raw: string | undefined): FieldPatch {
  if (raw === undefined) return undefined;
  return raw === '' ? null : raw;
}

export function validateSessionsMode(raw: string | undefined): string | { error: string } | undefined {
  if (raw === undefined) return undefined;
  if (!(SESSIONS_MODES as readonly string[]).includes(raw)) {
    return { error: `--sessions must be ${SESSIONS_MODES.join(' or ')} (got "${raw}").` };
  }
  return raw;
}

/** Build the POST /spaces body. `name` is required and never cleared. */
export function buildCreateBody(
  name: string,
  opts: {
    slug?: string;
    description?: string;
    agent?: string;
    sessions?: string;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = { name };
  if (opts.slug) body.slug = opts.slug;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.agent !== undefined) body.agent = opts.agent;
  if (opts.sessions !== undefined) body.sessions = opts.sessions;
  return body;
}

/** Build the PATCH /spaces/:slug body: only fields the caller named. */
export function buildUpdateBody(opts: {
  name?: FieldPatch;
  description?: FieldPatch;
  agent?: FieldPatch;
  sessions?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.agent !== undefined) body.agent = opts.agent;
  if (opts.sessions !== undefined) body.sessions = opts.sessions;
  return body;
}

/** `--expires YYYY-MM-DD` → end-of-day UTC ISO instant. */
export function expiresAtEndOfDay(raw: string): string | { error: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return { error: '--expires must be YYYY-MM-DD.' };
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  // Date.UTC silently rolls an out-of-range day/month into the next one
  // (e.g. Feb 30 → Mar 2) instead of failing — round-trip the parts to
  // reject that instead of committing an expiry on the wrong day.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return { error: '--expires must be YYYY-MM-DD.' };
  }
  return d.toISOString();
}

// ── ls / show ────────────────────────────────────────────────────────────────

async function spacesLs(ctx: ProjectCtx, base: string, json: boolean): Promise<number> {
  const resp = await ctx.client.get<SpacesListResponse>(base);
  if (json) {
    emitJson(resp);
    return 0;
  }
  if (resp.spaces.length === 0) {
    process.stdout.write(
      `  ${C.dim}No spaces yet. Create one: ${C.reset}${C.cyan}kortix spaces create "<name>"${C.reset}\n`,
    );
  } else {
    const slugW = Math.max(...resp.spaces.map((s) => s.slug.length), 4);
    const nameW = Math.max(...resp.spaces.map((s) => s.name.length), 4);
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.dim}${pad('SLUG', slugW)}   ${pad('NAME', nameW)}   AGENT            SESSIONS   #SESSIONS   #TRIGGERS${C.reset}\n`,
    );
    for (const s of resp.spaces) {
      process.stdout.write(
        `  ${pad(s.slug, slugW)}   ${pad(s.name, nameW)}   ${pad(s.agent ?? '—', 15)}  ${pad(s.sessions, 9)}  ${pad(String(s.session_count), 10)}  ${s.trigger_count}\n`,
      );
    }
    process.stdout.write(
      `\n  ${C.dim}${resp.spaces.length} space${resp.spaces.length === 1 ? '' : 's'}${C.reset}\n`,
    );
  }
  if (resp.errors.length > 0) {
    process.stdout.write(`\n  ${status.warn(`${resp.errors.length} manifest error${resp.errors.length === 1 ? '' : 's'}:`)}\n`);
    for (const e of resp.errors) {
      process.stdout.write(`    ${C.red}${e.path}${C.reset}: ${e.error}\n`);
    }
  }
  process.stdout.write('\n');
  return 0;
}

async function spacesShow(
  ctx: ProjectCtx,
  base: string,
  slug: string | undefined,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a space slug');
  const s = await ctx.client.get<Space>(`${base}/${encodeURIComponent(slug)}`);
  if (json) {
    emitJson(s);
    return 0;
  }
  const rows: Array<[string, string]> = [
    ['slug', s.slug],
    ['name', s.name],
    ['description', s.description ?? '—'],
    ['agent', s.agent ?? '—'],
    ['sessions', s.sessions],
    ['session_count', String(s.session_count)],
    ['trigger_count', String(s.trigger_count)],
    ['path', s.path],
  ];
  const labelW = Math.max(...rows.map(([label]) => label.length)) + 1;
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${s.name}${C.reset} ${C.faded}(${s.slug})${C.reset}\n`);
  for (const [label, value] of rows) {
    process.stdout.write(`  ${C.dim}${pad(label, labelW)} ${C.reset}${value}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

// ── create / update ─────────────────────────────────────────────────────────

async function spacesCreate(
  ctx: ProjectCtx,
  base: string,
  name: string | undefined,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!name) return missing('a name');
  const sessions = validateSessionsMode(f.sessions);
  if (sessions && typeof sessions === 'object') return fail(sessions.error);
  const body = buildCreateBody(name, {
    slug: f.slug,
    description: f.description,
    agent: f.agent,
    sessions,
  });
  const created = await ctx.client.post<Space>(base, body);
  if (json) {
    emitJson(created);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Created ${C.bold}${created.name}${C.reset}`)} ${C.dim}(${created.slug}, committed to kortix.yaml)${C.reset}\n`,
  );
  return 0;
}

async function spacesUpdate(
  ctx: ProjectCtx,
  base: string,
  slug: string | undefined,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a space slug');
  const sessions = validateSessionsMode(f.sessions);
  if (sessions && typeof sessions === 'object') return fail(sessions.error);
  const body = buildUpdateBody({
    name: resolveOptionalField(f.name),
    description: resolveOptionalField(f.description),
    agent: resolveOptionalField(f.agent),
    sessions,
  });
  if (Object.keys(body).length === 0) {
    return fail('Pass at least one field to change (see `kortix spaces --help`).');
  }
  const updated = await ctx.client.patch<Space>(`${base}/${encodeURIComponent(slug)}`, body);
  if (json) {
    emitJson(updated);
    return 0;
  }
  const changed = Object.keys(body).sort().join(', ');
  process.stdout.write(`${status.ok(`Updated ${C.bold}${updated.slug}${C.reset}`)} ${C.dim}(${changed})${C.reset}\n`);
  return 0;
}

async function spacesRm(
  ctx: ProjectCtx,
  base: string,
  slug: string | undefined,
  yes: boolean,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a space slug');
  if (!yes) {
    if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
      process.stderr.write(
        `${status.err('Refusing to delete without confirmation on a non-interactive terminal.')} Pass ${C.cyan}--yes${C.reset}.\n`,
      );
      return 2;
    }
    const ok = await confirm(
      `Delete space ${C.bold}${slug}${C.reset}? Sessions keep their history but lose the grouping.`,
      false,
      { onEndOfInput: false },
    );
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }
  await ctx.client.delete(`${base}/${encodeURIComponent(slug)}`);
  if (json) {
    emitJson({ ok: true, slug });
    return 0;
  }
  process.stdout.write(`${status.ok(`Removed ${C.bold}${slug}${C.reset}`)} ${C.dim}(kortix.yaml on main)${C.reset}\n`);
  return 0;
}

function fail(message: string): number {
  process.stderr.write(`${status.err(message)}\n`);
  return 2;
}

// ── grant / revoke ───────────────────────────────────────────────────────────

/** Resolve `--member`/`--group` into one `{type, id}` principal. Exactly one
 *  of the two must be set — the caller already parsed the flags. */
async function resolvePrincipal(
  ctx: ProjectCtx,
  f: Record<string, string | undefined>,
): Promise<{ type: 'member' | 'group'; id: string } | { error: string | null }> {
  if (f.member && f.group) return { error: 'Pass --member or --group, not both.' };
  if (f.member) {
    const id = await resolveMemberId(ctx.client, `/projects/${ctx.projectId}`, f.member);
    if (!id) return { error: null }; // resolveMemberId already printed the reason
    return { type: 'member', id };
  }
  if (f.group) {
    if (!UUID_RE.test(f.group)) return { error: '--group expects a group id.' };
    return { type: 'group', id: f.group };
  }
  return { error: 'Pass --member <id|email> or --group <id>.' };
}

async function spacesGrant(
  ctx: ProjectCtx,
  slug: string | undefined,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a space slug');
  const principal = await resolvePrincipal(ctx, f);
  if ('error' in principal) return principal.error === null ? 1 : fail(principal.error);

  let expiresAt: string | undefined;
  if (f.expires) {
    const resolved = expiresAtEndOfDay(f.expires);
    if (typeof resolved === 'object') return fail(resolved.error);
    expiresAt = resolved;
  }

  const resp = await ctx.client.post<{ grant_id: string }>(
    `/projects/${ctx.projectId}/resource-grants`,
    {
      resource_type: 'space',
      resource_id: slug,
      principal_type: principal.type,
      principal_id: principal.id,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    },
  );
  if (json) {
    emitJson(resp);
    return 0;
  }
  const who = principal.type === 'group' ? `group ${principal.id}` : f.member;
  process.stdout.write(
    `${status.ok(`Granted ${C.bold}${slug}${C.reset} → ${C.bold}${who}${C.reset}`)}\n`,
  );
  return 0;
}

async function spacesRevoke(
  ctx: ProjectCtx,
  slug: string | undefined,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a space slug');
  const principal = await resolvePrincipal(ctx, f);
  if ('error' in principal) return principal.error === null ? 1 : fail(principal.error);

  const resp = await ctx.client.get<ResourceGrantsResponse>(
    `/projects/${ctx.projectId}/resource-grants`,
  );
  const grant = resp.grants.find(
    (g) =>
      g.resource_type === 'space' &&
      g.resource_id === slug &&
      g.principal_type === principal.type &&
      g.principal_id === principal.id,
  );
  if (!grant) {
    process.stderr.write(
      `${status.err(`No grant of ${slug} to that ${principal.type} — see \`kortix grants ls\`.`)}\n`,
    );
    return 1;
  }
  await ctx.client.delete(`/projects/${ctx.projectId}/resource-grants/${encodeURIComponent(grant.grant_id)}`);
  if (json) {
    emitJson({ ok: true, grant_id: grant.grant_id });
    return 0;
  }
  process.stdout.write(`${status.ok(`Revoked ${C.bold}${slug}${C.reset}`)}\n`);
  return 0;
}
