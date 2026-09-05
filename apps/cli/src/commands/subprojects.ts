import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { resolveMemberId } from './grants.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';

// A subproject is a named container inside a project: it groups sessions,
// gives the agent standing context, and owns scheduled work — see
// docs/specs/2026-09-03-subprojects.md §2, §6. The manifest (kortix.yaml) is
// the source of truth; every write here commits to it.

/** Wire shape — SubprojectSchema, docs/specs/2026-09-03-subprojects.md §6. */
export interface Subproject {
  slug: string;
  name: string;
  description: string | null;
  instructions: string | null;
  context: string[];
  agent: string | null;
  sessions: 'private' | 'shared';
  path: string;
  session_count: number;
  trigger_count: number;
  can_manage: boolean;
}

interface SubprojectsListResponse {
  subprojects: Subproject[];
  errors: Array<{ slug: string; path: string; error: string }>;
}

/** One row of `GET /projects/:id/resource-grants` — locally typed rather than
 *  widening grants.ts's agent/skill/secret-only union, since only the fields
 *  used to find a subproject grant to revoke matter here. */
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

const HELP = help`Usage: kortix subprojects <subcommand> [options]

A subproject groups sessions under a named effort inside the project, with its
own standing instructions, reference files, default agent, and scheduled work.
The manifest (\`kortix.yaml\` \`subprojects.<slug>\`) is the source of truth —
every write below commits to it.

Subcommands:
  ls [--json]                     List subprojects you can see.
  show <slug> [--json]            Show one subproject in full.
  create <name> [options]         Declare a new subproject.
  update <slug> [options]         Change fields on an existing subproject.
  rm <slug> [--yes]               Delete a subproject. Sessions keep their
                                  history but lose the grouping; scheduled
                                  triggers naming it are un-scoped, not deleted.
  context add <slug> <file> [--as name]
                                  Upload a local file as subproject context.
  context rm <slug> <path>        Drop one context entry (never deletes the repo file).
  grant <slug> (--member <id|email> | --group <id>) [--expires YYYY-MM-DD]
                                  Let a member or group use this subproject.
  revoke <slug> (--member <id|email> | --group <id>)
                                  Remove that grant.

Create/update options:
  --slug <s>            Explicit slug (create only; defaults to slugify(name)).
  --name <text>          Display name (update only — \`create <name>\` is positional).
  --description <text>
  --agent <name>         Default agent for sessions started in it.
  --instructions-file <f|->
                         Inline standing instructions from a file, or stdin (\`-\`).
  --context <path>       Repo-relative context path. Repeatable. On \`update\`
                         this REPLACES the whole context[] list.
  --sessions private|shared
                         private (default): a session is visible to its
                         creator only. shared: every session in it is visible
                         to everyone granted the subproject.

On \`update\`, an empty value (\`--description=\`, \`--agent=\`,
\`--instructions-file=\`) clears that field. \`name\` cannot be cleared.

Global:
  --project <id>     Operate on this project id (default: linked).
  --host <name>       Operate against a non-default Kortix host.
  --json               Machine-readable output.
  -h, --help           Show this help.

Create/update/rm/grant/revoke need \`project.customize.write\`.
`;

type ProjectCtx = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>;

export async function runSubprojects(argv: string[]): Promise<number> {
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
  let contextPaths: string[] = [];
  let asName: string | undefined;
  try {
    json = takeFlagBool(rest, ['--json']);
    yes = takeFlagBool(rest, ['--yes', '-y']);
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.slug = takeFlagValue(rest, ['--slug']);
    f.name = takeFlagValue(rest, ['--name']);
    f.description = takeFlagValue(rest, ['--description']);
    f.agent = takeFlagValue(rest, ['--agent']);
    f.instructionsFile = takeFlagValue(rest, ['--instructions-file']);
    f.sessions = takeFlagValue(rest, ['--sessions']);
    f.member = takeFlagValue(rest, ['--member']);
    f.group = takeFlagValue(rest, ['--group']);
    f.expires = takeFlagValue(rest, ['--expires']);
    contextPaths = takeFlagValues(rest, ['--context']);
    asName = takeFlagValue(rest, ['--as']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/subprojects`;

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return subprojectsLs(ctx, base, json);
      case 'show':
      case 'info':
        return subprojectsShow(ctx, base, positional[0], json);
      case 'create':
        return subprojectsCreate(ctx, base, positional[0], f, contextPaths, json);
      case 'update':
      case 'set':
        return subprojectsUpdate(ctx, base, positional[0], f, contextPaths, json);
      case 'rm':
      case 'remove':
      case 'delete':
        return subprojectsRm(ctx, base, positional[0], yes, json);
      case 'context':
        // `sub` already consumed "context"; `positional` is `['add'|'rm', slug, path]`.
        return subprojectsContext(ctx, base, positional, asName, json);
      case 'grant':
        return subprojectsGrant(ctx, positional[0], f, json);
      case 'revoke':
        return subprojectsRevoke(ctx, positional[0], f, json);
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

/** `--instructions-file f|-` → file/stdin content, or `null` on an explicit
 *  empty value (`--instructions-file=` clears the field on update). */
export function readInstructionsFlag(raw: string | undefined): FieldPatch {
  if (raw === undefined) return undefined;
  if (raw === '') return null;
  return raw === '-' ? readFileSync(0, 'utf-8') : readFileSync(raw, 'utf-8');
}

export function validateSessionsMode(raw: string | undefined): string | { error: string } | undefined {
  if (raw === undefined) return undefined;
  if (!(SESSIONS_MODES as readonly string[]).includes(raw)) {
    return { error: `--sessions must be ${SESSIONS_MODES.join(' or ')} (got "${raw}").` };
  }
  return raw;
}

/** Build the POST /subprojects body. `name` is required and never cleared. */
export function buildCreateBody(
  name: string,
  opts: {
    slug?: string;
    description?: string;
    agent?: string;
    instructions?: string;
    context: string[];
    sessions?: string;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = { name };
  if (opts.slug) body.slug = opts.slug;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.agent !== undefined) body.agent = opts.agent;
  if (opts.instructions !== undefined) body.instructions = opts.instructions;
  if (opts.context.length > 0) body.context = opts.context;
  if (opts.sessions !== undefined) body.sessions = opts.sessions;
  return body;
}

/** Build the PATCH /subprojects/:slug body: only fields the caller named. */
export function buildUpdateBody(opts: {
  name?: FieldPatch;
  description?: FieldPatch;
  agent?: FieldPatch;
  instructions?: FieldPatch;
  context?: string[];
  sessions?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.agent !== undefined) body.agent = opts.agent;
  if (opts.instructions !== undefined) body.instructions = opts.instructions;
  if (opts.context !== undefined) body.context = opts.context;
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

async function subprojectsLs(ctx: ProjectCtx, base: string, json: boolean): Promise<number> {
  const resp = await ctx.client.get<SubprojectsListResponse>(base);
  if (json) {
    emitJson(resp);
    return 0;
  }
  if (resp.subprojects.length === 0) {
    process.stdout.write(
      `  ${C.dim}No subprojects yet. Create one: ${C.reset}${C.cyan}kortix subprojects create "<name>"${C.reset}\n`,
    );
  } else {
    const slugW = Math.max(...resp.subprojects.map((s) => s.slug.length), 4);
    const nameW = Math.max(...resp.subprojects.map((s) => s.name.length), 4);
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.dim}${pad('SLUG', slugW)}   ${pad('NAME', nameW)}   AGENT            SESSIONS   #SESSIONS   #TRIGGERS${C.reset}\n`,
    );
    for (const s of resp.subprojects) {
      process.stdout.write(
        `  ${pad(s.slug, slugW)}   ${pad(s.name, nameW)}   ${pad(s.agent ?? '—', 15)}  ${pad(s.sessions, 9)}  ${pad(String(s.session_count), 10)}  ${s.trigger_count}\n`,
      );
    }
    process.stdout.write(
      `\n  ${C.dim}${resp.subprojects.length} subproject${resp.subprojects.length === 1 ? '' : 's'}${C.reset}\n`,
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

async function subprojectsShow(
  ctx: ProjectCtx,
  base: string,
  slug: string | undefined,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a subproject slug');
  const s = await ctx.client.get<Subproject>(`${base}/${encodeURIComponent(slug)}`);
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
    ['context', s.context.length > 0 ? s.context.join(', ') : '—'],
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
  process.stdout.write(`\n  ${C.dim}instructions${C.reset}\n`);
  process.stdout.write(s.instructions ? `${s.instructions}\n` : `  ${C.faded}(none)${C.reset}\n`);
  process.stdout.write('\n');
  return 0;
}

// ── create / update ─────────────────────────────────────────────────────────

async function subprojectsCreate(
  ctx: ProjectCtx,
  base: string,
  name: string | undefined,
  f: Record<string, string | undefined>,
  contextPaths: string[],
  json: boolean,
): Promise<number> {
  if (!name) return missing('a name');
  const sessions = validateSessionsMode(f.sessions);
  if (sessions && typeof sessions === 'object') return fail(sessions.error);
  let instructions: string | undefined;
  if (f.instructionsFile !== undefined) {
    try {
      instructions =
        f.instructionsFile === '-' ? readFileSync(0, 'utf-8') : readFileSync(f.instructionsFile, 'utf-8');
    } catch (err) {
      return fail(`Could not read ${f.instructionsFile}: ${(err as Error).message}`);
    }
  }
  const body = buildCreateBody(name, {
    slug: f.slug,
    description: f.description,
    agent: f.agent,
    instructions,
    context: contextPaths,
    sessions,
  });
  const created = await ctx.client.post<Subproject>(base, body);
  if (json) {
    emitJson(created);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Created ${C.bold}${created.name}${C.reset}`)} ${C.dim}(${created.slug}, committed to kortix.yaml)${C.reset}\n`,
  );
  return 0;
}

async function subprojectsUpdate(
  ctx: ProjectCtx,
  base: string,
  slug: string | undefined,
  f: Record<string, string | undefined>,
  contextPaths: string[],
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a subproject slug');
  const sessions = validateSessionsMode(f.sessions);
  if (sessions && typeof sessions === 'object') return fail(sessions.error);
  let instructions: FieldPatch;
  try {
    instructions = readInstructionsFlag(f.instructionsFile);
  } catch (err) {
    return fail(`Could not read ${f.instructionsFile}: ${(err as Error).message}`);
  }
  const body = buildUpdateBody({
    name: resolveOptionalField(f.name),
    description: resolveOptionalField(f.description),
    agent: resolveOptionalField(f.agent),
    instructions,
    context: contextPaths.length > 0 ? contextPaths : undefined,
    sessions,
  });
  if (Object.keys(body).length === 0) {
    return fail('Pass at least one field to change (see `kortix subprojects --help`).');
  }
  const updated = await ctx.client.patch<Subproject>(`${base}/${encodeURIComponent(slug)}`, body);
  if (json) {
    emitJson(updated);
    return 0;
  }
  const changed = Object.keys(body).sort().join(', ');
  process.stdout.write(`${status.ok(`Updated ${C.bold}${updated.slug}${C.reset}`)} ${C.dim}(${changed})${C.reset}\n`);
  return 0;
}

async function subprojectsRm(
  ctx: ProjectCtx,
  base: string,
  slug: string | undefined,
  yes: boolean,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a subproject slug');
  if (!yes) {
    if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
      process.stderr.write(
        `${status.err('Refusing to delete without confirmation on a non-interactive terminal.')} Pass ${C.cyan}--yes${C.reset}.\n`,
      );
      return 2;
    }
    const ok = await confirm(
      `Delete subproject ${C.bold}${slug}${C.reset}? Sessions keep their history but lose the grouping.`,
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

// ── context ──────────────────────────────────────────────────────────────────

async function subprojectsContext(
  ctx: ProjectCtx,
  base: string,
  args: string[],
  asName: string | undefined,
  json: boolean,
): Promise<number> {
  const action = args[0];
  if (action === 'add') {
    const slug = args[1];
    const file = args[2];
    if (!slug || !file) return missing('a subproject slug and a local file path');
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch (err) {
      return fail(`Could not read ${file}: ${(err as Error).message}`);
    }
    const path = asName || basename(file);
    const updated = await ctx.client.post<Subproject>(
      `${base}/${encodeURIComponent(slug)}/context`,
      { path, content },
    );
    if (json) {
      emitJson(updated);
      return 0;
    }
    process.stdout.write(
      `${status.ok(`Added ${C.bold}${path}${C.reset} to ${slug}'s context`)} ${C.dim}(committed to kortix.yaml + .kortix/subprojects/${slug}/)${C.reset}\n`,
    );
    return 0;
  }
  if (action === 'rm' || action === 'remove' || action === 'delete') {
    const slug = args[1];
    const path = args[2];
    if (!slug || !path) return missing('a subproject slug and a context path');
    await ctx.client.delete(
      `${base}/${encodeURIComponent(slug)}/context?path=${encodeURIComponent(path)}`,
    );
    if (json) {
      emitJson({ ok: true, slug, path });
      return 0;
    }
    process.stdout.write(`${status.ok(`Removed ${C.bold}${path}${C.reset} from ${slug}'s context`)}\n`);
    return 0;
  }
  process.stderr.write(`${status.err('Pass `context add <slug> <file>` or `context rm <slug> <path>`.')}\n`);
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

async function subprojectsGrant(
  ctx: ProjectCtx,
  slug: string | undefined,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a subproject slug');
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
      resource_type: 'subproject',
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

async function subprojectsRevoke(
  ctx: ProjectCtx,
  slug: string | undefined,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a subproject slug');
  const principal = await resolvePrincipal(ctx, f);
  if ('error' in principal) return principal.error === null ? 1 : fail(principal.error);

  const resp = await ctx.client.get<ResourceGrantsResponse>(
    `/projects/${ctx.projectId}/resource-grants`,
  );
  const grant = resp.grants.find(
    (g) =>
      g.resource_type === 'subproject' &&
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
