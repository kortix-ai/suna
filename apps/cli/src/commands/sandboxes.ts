import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import {
  appendArrayBlock,
  arrayEntryExists,
  removeArrayBlock,
  setScalarInArrayBlock,
} from '../manifest-edit.ts';
import { C, pad, status } from '../style.ts';

// ── Shapes (mirror apps/api/src/projects sandbox-template + snapshot routes) ─

interface SandboxTemplate {
  template_id: string | null;
  slug: string;
  name: string;
  is_default: boolean;
  source: 'platform' | 'toml' | 'ui';
  provider: string;
  has_dockerfile: boolean;
  has_image: boolean;
  image: string | null;
  dockerfile_path: string | null;
  entrypoint: string | null;
  cpu: number;
  memory_gb: number;
  disk_gb: number;
  snapshot_name: string;
  content_hash: string;
  daytona_state: string;
  provider_state: string;
  ready: boolean;
}

interface SnapshotBuild {
  build_id: string;
  slug: string;
  status: 'building' | 'ready' | 'failed';
  error: string | null;
  error_category: string | null;
  source: string | null;
  started_at: string;
  finished_at: string | null;
}

const HELP = `Usage: kortix sandboxes <subcommand> [options]

Manage the project's sandbox images — the same surface as the dashboard's
Customize → Sandbox images. A template is a definition (image OR Dockerfile +
resources); a build produces the actual snapshot the platform boots sessions
from. Templates also come from \`[[sandbox.templates]]\` in kortix.toml.

Subcommands:
  ls [--json]                       List templates + live provider state.
  builds [--json]                   Recent build log (last 25).
  health [--json]                   Primary template readiness (quick check).
  add <slug> (--image <i> | --dockerfile <p>) [--name ...] [--cpu n] [--memory n] [--disk n]
                                    Create a custom template (kicks a build).
  update <slug> [--name ...] [--image ...] [--dockerfile ...] [--cpu n] [--memory n] [--disk n]
                                    Update a UI-created template.
  build <slug>                      Trigger a rebuild for a template.
  rebuild <slug>                    Force-rebuild (delete existing snapshot first).
  rm <slug>                         Delete a UI-created template.
  fix                               Start a session seeded with the last failed
                                    build log so an agent can repair it.

Options:
  --image <ref>        Public docker image (mutually exclusive with --dockerfile).
  --dockerfile <path>  Repo-relative Dockerfile path.
  --name <label>       Display name (default: slug).
  --cpu <n>            vCPUs.   --memory <n>  GiB RAM.   --disk <n>  GiB disk.
  --project <id>       Operate on this project id (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  -h, --help           Show this help.
`;

export async function runSandboxes(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  try {
    json = takeFlagBool(rest, ['--json']);
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.image = takeFlagValue(rest, ['--image']);
    f.dockerfile = takeFlagValue(rest, ['--dockerfile']);
    f.name = takeFlagValue(rest, ['--name']);
    f.cpu = takeFlagValue(rest, ['--cpu']);
    f.memory = takeFlagValue(rest, ['--memory']);
    f.disk = takeFlagValue(rest, ['--disk']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  // ── Template definitions live in kortix.toml `[[sandbox.templates]]` (source of
  //    truth). add/update/rm edit the LOCAL file — `kortix ship` applies +
  //    builds. Only build/rebuild/health/builds/fix are cloud actions. ────────
  if (sub === 'add' || sub === 'create') return sandboxAddLocal(positional[0], f);
  if (sub === 'update' || sub === 'edit') return sandboxUpdateLocal(positional[0], f);
  if (sub === 'rm' || sub === 'remove' || sub === 'delete') return sandboxRmLocal(positional[0]);

  const ctx = resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}`;

  // Resolve a slug to a project-scoped template_id (needed for PATCH/DELETE/build).
  const findTemplateId = async (slug: string): Promise<string | null> => {
    const resp = await ctx.client.get<{ items: SandboxTemplate[] }>(`${base}/sandbox-templates`);
    return resp.items.find((t) => t.slug === slug)?.template_id ?? null;
  };

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const resp = await ctx.client.get<{ items: SandboxTemplate[]; default_slug: string | null }>(
          `${base}/sandbox-templates`,
        );
        if (json) {
          emitJson(resp);
          return 0;
        }
        const slugW = Math.max(...resp.items.map((t) => t.slug.length), 4);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('SLUG', slugW)}   STATE       SOURCE     SPEC                       RESOURCES${C.reset}\n`,
        );
        for (const t of resp.items) {
          const spec = t.has_image ? t.image! : t.has_dockerfile ? t.dockerfile_path! : 'platform default';
          const marker = t.slug === resp.default_slug ? `${C.green}●${C.reset} ` : '  ';
          process.stdout.write(
            `${marker}${pad(t.slug, slugW)}   ${stateCell(t.daytona_state, t.ready)}  ${pad(t.source, 9)}  ${pad(trim(spec, 24), 24)}  ${C.faded}${t.cpu}cpu/${t.memory_gb}g/${t.disk_gb}g${C.reset}\n`,
          );
        }
        process.stdout.write(`\n  ${C.dim}${resp.items.length} template${resp.items.length === 1 ? '' : 's'} · default: ${resp.default_slug ?? '—'}${C.reset}\n\n`);
        return 0;
      }
      case 'builds':
      case 'log': {
        const resp = await ctx.client.get<{ builds: SnapshotBuild[] }>(`${base}/snapshots`);
        if (json) {
          emitJson(resp);
          return 0;
        }
        if (resp.builds.length === 0) {
          process.stdout.write(`  ${C.dim}No builds yet.${C.reset}\n`);
          return 0;
        }
        process.stdout.write('\n');
        process.stdout.write(`  ${C.dim}${pad('SLUG', 12)}  STATUS    SOURCE          STARTED${C.reset}\n`);
        for (const b of resp.builds) {
          const sc = b.status === 'ready' ? C.green : b.status === 'failed' ? C.red : C.yellow;
          process.stdout.write(
            `  ${pad(b.slug, 12)}  ${sc}${pad(b.status, 8)}${C.reset}  ${pad(b.source ?? '—', 14)}  ${C.faded}${b.started_at.slice(0, 19).replace('T', ' ')}${C.reset}\n`,
          );
          if (b.status === 'failed' && b.error) {
            process.stdout.write(`    ${C.red}${trim(b.error.split('\n')[0]!, 80)}${C.reset}${b.error_category ? ` ${C.faded}[${b.error_category}]${C.reset}` : ''}\n`);
          }
        }
        process.stdout.write(`\n  ${C.dim}${resp.builds.length} build${resp.builds.length === 1 ? '' : 's'}${C.reset}\n\n`);
        return 0;
      }
      case 'health': {
        const h = await ctx.client.get<{
          primary_slug: string | null;
          ready: boolean;
          building: boolean;
          latest_failure: SnapshotBuild | null;
        }>(`${base}/sandbox-health`);
        if (json) {
          emitJson(h);
          return 0;
        }
        const state = h.ready ? `${C.green}ready${C.reset}` : h.building ? `${C.yellow}building${C.reset}` : `${C.red}not ready${C.reset}`;
        process.stdout.write(`\n  primary ${C.bold}${h.primary_slug ?? '—'}${C.reset}  ${state}\n`);
        if (h.latest_failure) {
          process.stdout.write(`  ${C.red}last failure:${C.reset} ${trim(h.latest_failure.error?.split('\n')[0] ?? 'unknown', 80)}\n`);
          process.stdout.write(`  ${C.dim}Repair it with ${C.reset}${C.cyan}kortix sandboxes fix${C.reset}\n`);
        }
        process.stdout.write('\n');
        return 0;
      }
      case 'build': {
        const slug = positional[0];
        if (!slug) return missing('a template slug');
        const id = await findTemplateId(slug);
        if (!id) {
          process.stderr.write(`${status.err(`No project-scoped template "${slug}" to build.`)}\n`);
          return 1;
        }
        await ctx.client.post(`${base}/sandbox-templates/${id}/build`);
        process.stdout.write(`${status.ok(`Build started for ${C.bold}${slug}${C.reset}`)}\n`);
        return 0;
      }
      case 'rebuild': {
        const slug = positional[0];
        if (!slug) return missing('a template slug');
        const resp = await ctx.client.post<{ deleted_existing: boolean; snapshot_name: string }>(
          `${base}/snapshots/rebuild`,
          { slug },
        );
        process.stdout.write(`${status.ok(`Rebuild started for ${C.bold}${slug}${C.reset}${resp.deleted_existing ? ' (old snapshot deleted)' : ''}`)}\n`);
        return 0;
      }
      case 'fix': {
        const resp = await ctx.client.post<{ session_id: string }>(`${base}/snapshots/fix-with-agent`);
        process.stdout.write(`${status.ok(`Fix session started ${C.bold}${resp.session_id.split('-')[0]}${C.reset}`)}\n`);
        process.stdout.write(`  ${C.dim}Chat with it: ${C.reset}${C.cyan}kortix chat ${resp.session_id}${C.reset}\n`);
        return 0;
      }
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── Local kortix.toml `[[sandbox.templates]]` edits (source of truth) ────────────────

function sandboxAddLocal(slug: string | undefined, f: Record<string, string | undefined>): number {
  if (!slug) return missing('a template slug');
  if (!f.image && !f.dockerfile) return missing('--image or --dockerfile');
  if (f.image && f.dockerfile) {
    process.stderr.write(`${status.err('Pass only one of --image / --dockerfile.')}\n`);
    return 2;
  }
  try {
    if (arrayEntryExists('sandbox.templates', 'slug', slug)) {
      process.stderr.write(`${status.err(`A [[sandbox.templates]] "${slug}" already exists in kortix.toml.`)}\n`);
      return 1;
    }
    const fields: Record<string, unknown> = { slug };
    if (f.name) fields.name = f.name;
    if (f.image) fields.image = f.image;
    if (f.dockerfile) fields.dockerfile = f.dockerfile;
    if (f.cpu) fields.cpu = Number(f.cpu);
    if (f.memory) fields.memory = Number(f.memory);
    if (f.disk) fields.disk = Number(f.disk);
    appendArrayBlock('sandbox.templates', fields);
    process.stdout.write(
      `${status.ok(`Added [[sandbox.templates]] ${C.bold}${slug}${C.reset} to kortix.toml`)} ${C.dim}— \`kortix ship\` builds it.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

function sandboxUpdateLocal(slug: string | undefined, f: Record<string, string | undefined>): number {
  if (!slug) return missing('a template slug');
  try {
    if (!arrayEntryExists('sandbox.templates', 'slug', slug)) {
      process.stderr.write(`${status.err(`No [[sandbox.templates]] "${slug}" in kortix.toml (platform/UI templates aren't file-based).`)}\n`);
      return 1;
    }
    const updates: Array<[string, string | number]> = [];
    if (f.name) updates.push(['name', f.name]);
    if (f.image) updates.push(['image', f.image]);
    if (f.dockerfile) updates.push(['dockerfile', f.dockerfile]);
    if (f.cpu) updates.push(['cpu', Number(f.cpu)]);
    if (f.memory) updates.push(['memory', Number(f.memory)]);
    if (f.disk) updates.push(['disk', Number(f.disk)]);
    if (updates.length === 0) return missing('at least one field to update');
    for (const [k, v] of updates) setScalarInArrayBlock('sandbox.templates', 'slug', slug, k, v);
    process.stdout.write(
      `${status.ok(`Updated [[sandbox.templates]] ${C.bold}${slug}${C.reset}`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

function sandboxRmLocal(slug: string | undefined): number {
  if (!slug) return missing('a template slug');
  try {
    if (!removeArrayBlock('sandbox.templates', 'slug', slug)) {
      process.stderr.write(`${status.err(`No [[sandbox.templates]] "${slug}" in kortix.toml.`)}\n`);
      return 1;
    }
    process.stdout.write(
      `${status.ok(`Removed [[sandbox.templates]] ${C.bold}${slug}${C.reset}`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

function stateCell(state: string, ready: boolean): string {
  const color = ready ? C.green : state === 'error' ? C.red : state === 'missing' ? C.faded : C.yellow;
  return `${color}${pad(state, 11)}${C.reset}`;
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
