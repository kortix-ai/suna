import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
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
import { C, help, pad, status, trim } from '../style.ts';
import { runSandboxBuildLocal } from './sandboxes-local.ts';
import { sandboxProvider } from './sandboxes-pin.ts';

type Client = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>['client'];

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

const HELP = help`Usage: kortix sandboxes <subcommand> [options]

Manage the project's sandbox images — the same surface as the dashboard's
Customize → Sandbox images. A template is a definition (image OR Dockerfile +
resources); a build produces the actual snapshot the platform boots sessions
from. Templates also come from \`[[sandbox.templates]]\` in kortix.yaml.

Subcommands:
  ls [--json]                       List templates + live provider state.
  builds [--json]                   Recent build log (last 25).
  health [--json]                   Primary template readiness (quick check).
  add <slug> (--image <i> | --dockerfile <p>) [--name ...] [--cpu n] [--memory n] [--disk n]
                                    Create a custom template (kicks a build).
  update <slug> [--name ...] [--image ...] [--dockerfile ...] [--cpu n] [--memory n] [--disk n]
                                    Update a UI-created template.
  build <slug>                      Trigger a rebuild for a template.
  build --local [slug]              Build the image HERE, on your Docker, before
                                    you push. See "Local build" below.
  rebuild <slug>                    Force-rebuild (delete existing snapshot first).
  rm <slug>                         Delete a UI-created template.
  fix                               Start a session seeded with the last failed
                                    build log so an agent can repair it.
  provider [--json]                 Show the project's sandbox-provider pin and
                                    which providers this host offers.
  provider <name> [--timeout <sec>] Pin every new session to one provider. If
                                    the target needs its snapshot built first
                                    the API answers with a PREPARATION and this
                                    follows it to completion (default 600s).
  provider --clear                  Drop the pin — follow the platform default.
  provider status [--json]          Show the latest provider transition + history.

Local build (build --local):
  Renders your Dockerfile + the Kortix toolchain layer and builds it with an
  EMPTY context — the same repo-less constraint the cloud builds under. Needs
  no login and no linked project, just Docker. For the checks that need neither,
  run \`kortix validate\` (it lints these Dockerfiles statically).

  Slug: the positional, else \`sandbox.default\`, else your only template.

  --local              Build locally instead of triggering a cloud build.
  --platform <p>       Target platform (default: this host's). The cloud always
                       builds linux/amd64; matching it here is exact but slow
                       under emulation.
  --tag <t>            Image tag (default: kortix-local/<slug>:latest).
  --no-cache           Pass --no-cache to docker build.
  --no-layer           Build only your Dockerfile, without the Kortix layer.
  --print              Print the composed Dockerfile to stdout and exit.

Options:
  --image <ref>        Public docker image (mutually exclusive with --dockerfile).
  --dockerfile <path>  Repo-relative Dockerfile path.
  --name <label>       Display name (default: slug).
  --cpu <n>            vCPUs.   --memory <n>  GiB RAM.   --disk <n>  GiB disk.
  --clear              provider: remove the pin instead of setting one.
  --timeout <sec>      provider: how long to follow a preparation (default 600).
  --project <id>       Operate on this project id (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  -h, --help           Show this help.

Pinning a provider needs the \`project.customize.write\` permission.
`;

/** The `sandboxes` flags. Values arrive as strings; each use parses its own. */
interface Flags {
  timeout?: string;
  project?: string;
  host?: string;
  image?: string;
  dockerfile?: string;
  name?: string;
  cpu?: string;
  memory?: string;
  disk?: string;
  json: boolean;
  local: boolean;
  clear: boolean;
}

export async function runSandboxes(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;

  const sub = argv[0];
  const rest = argv.slice(1);
  let f: Flags;
  try {
    f = {
      json: takeFlagBool(rest, ['--json']),
      local: takeFlagBool(rest, ['--local']),
      clear: takeFlagBool(rest, ['--clear', '--unpin']),
      timeout: takeFlagValue(rest, ['--timeout']),
      project: takeFlagValue(rest, ['--project']),
      host: takeFlagValue(rest, ['--host']),
      image: takeFlagValue(rest, ['--image']),
      dockerfile: takeFlagValue(rest, ['--dockerfile']),
      name: takeFlagValue(rest, ['--name']),
      cpu: takeFlagValue(rest, ['--cpu']),
      memory: takeFlagValue(rest, ['--memory']),
      disk: takeFlagValue(rest, ['--disk']),
    };
  } catch (err) {
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  // ── Template definitions live in kortix.yaml `[[sandbox.templates]]` (source of
  //    truth). add/update/rm edit the LOCAL file — `kortix ship` applies +
  //    builds. Only build/rebuild/health/builds/fix are cloud actions. ────────
  if (sub === 'add' || sub === 'create') return sandboxAddLocal(positional[0], f);
  if (sub === 'update' || sub === 'edit') return sandboxUpdateLocal(positional[0], f);
  if (sub === 'rm' || sub === 'remove' || sub === 'delete') return sandboxRmLocal(positional[0]);
  // `build --local` is the same kind of thing: it reads kortix.yaml + a
  // Dockerfile and talks to the local Docker daemon. No token, no linked
  // project, no network — so it must route above resolveProjectContext, which
  // would otherwise dead-end a logged-out developer on a pre-push check.
  // (It takes its own flags out of `rest` and reads the slug positional itself —
  // `positional` above was computed before --platform/--tag were stripped, so it
  // would mistake a flag VALUE for a slug.)
  if (sub === 'build' && f.local) return runSandboxBuildLocal(rest, { json: f.json });
  // `--local` was consumed above, so an unhandled one would otherwise vanish
  // and the command would quietly do the CLOUD thing instead — `sandboxes
  // rebuild --local` silently rebuilding a live snapshot is not a mistake
  // anyone should be able to make by typo.
  if (f.local) return fail(`--local only applies to \`sandboxes build\`, not "${sub}".`);

  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}`;

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return await sandboxesLs(ctx.client, base, f.json);
      case 'builds':
      case 'log':
        return await sandboxesBuilds(ctx.client, base, f.json);
      case 'health':
        return await sandboxesHealth(ctx.client, base, f.json);
      case 'build':
        return sandboxesBuild(ctx.client, base, positional[0]);
      case 'rebuild':
        return sandboxesRebuild(ctx.client, base, positional[0]);
      case 'provider':
        return await sandboxProvider(ctx.client, base, positional[0], {
          clear: f.clear,
          json: f.json,
          timeoutSec: f.timeout ? Number(f.timeout) : 600,
        });
      case 'fix': {
        const resp = await ctx.client.post<{ session_id: string }>(
          `${base}/snapshots/fix-with-agent`,
        );
        process.stdout.write(
          `${status.ok(`Fix session started ${C.bold}${resp.session_id.split('-')[0]}${C.reset}`)}\n`,
        );
        process.stdout.write(
          `  ${C.dim}Chat with it: ${C.reset}${C.cyan}kortix chat ${resp.session_id}${C.reset}\n`,
        );
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

async function sandboxesLs(client: Client, base: string, json: boolean): Promise<number> {
  const resp = await client.get<{ items: SandboxTemplate[]; default_slug: string | null }>(
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
    const spec = t.has_image
      ? t.image!
      : t.has_dockerfile
        ? t.dockerfile_path!
        : 'platform default';
    const marker = t.slug === resp.default_slug ? `${C.green}●${C.reset} ` : '  ';
    process.stdout.write(
      `${marker}${pad(t.slug, slugW)}   ${stateCell(t.daytona_state, t.ready)}  ${pad(t.source, 9)}  ${pad(trim(spec, 24), 24)}  ${C.faded}${t.cpu}cpu/${t.memory_gb}g/${t.disk_gb}g${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${resp.items.length} template${resp.items.length === 1 ? '' : 's'} · default: ${resp.default_slug ?? '—'}${C.reset}\n\n`,
  );
  return 0;
}

async function sandboxesBuilds(client: Client, base: string, json: boolean): Promise<number> {
  const resp = await client.get<{ builds: SnapshotBuild[] }>(`${base}/snapshots`);
  if (json) {
    emitJson(resp);
    return 0;
  }
  if (resp.builds.length === 0) {
    process.stdout.write(`  ${C.dim}No builds yet.${C.reset}\n`);
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('SLUG', 12)}  STATUS    SOURCE          STARTED${C.reset}\n`,
  );
  for (const b of resp.builds) {
    const sc = b.status === 'ready' ? C.green : b.status === 'failed' ? C.red : C.yellow;
    process.stdout.write(
      `  ${pad(b.slug, 12)}  ${sc}${pad(b.status, 8)}${C.reset}  ${pad(b.source ?? '—', 14)}  ${C.faded}${b.started_at.slice(0, 19).replace('T', ' ')}${C.reset}\n`,
    );
    if (b.status === 'failed' && b.error) {
      process.stdout.write(
        `    ${C.red}${trim(b.error.split('\n')[0]!, 80)}${C.reset}${b.error_category ? ` ${C.faded}[${b.error_category}]${C.reset}` : ''}\n`,
      );
    }
  }
  process.stdout.write(
    `\n  ${C.dim}${resp.builds.length} build${resp.builds.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

async function sandboxesHealth(client: Client, base: string, json: boolean): Promise<number> {
  const h = await client.get<{
    primary_slug: string | null;
    ready: boolean;
    building: boolean;
    latest_failure: SnapshotBuild | null;
    status?: {
      state: 'ready' | 'building' | 'not_built' | 'degraded' | 'blocked' | 'unknown';
      current_failure: SnapshotBuild | null;
      stale_failure: SnapshotBuild | null;
    } | null;
  }>(`${base}/sandbox-health`);
  if (json) {
    emitJson(h);
    return 0;
  }
  const currentState = h.status?.state ?? (h.ready ? 'ready' : h.building ? 'building' : 'unknown');
  const stateColor =
    currentState === 'ready'
      ? C.green
      : currentState === 'blocked' || currentState === 'degraded'
        ? C.red
        : C.yellow;
  const state = `${stateColor}${currentState.replace('_', ' ')}${C.reset}`;
  process.stdout.write(`\n  primary ${C.bold}${h.primary_slug ?? '—'}${C.reset}  ${state}\n`);
  const currentFailure = h.status ? h.status.current_failure : h.latest_failure;
  if (currentFailure) {
    process.stdout.write(
      `  ${C.red}current failure:${C.reset} ${trim(currentFailure.error?.split('\n')[0] ?? 'unknown', 80)}\n`,
    );
    process.stdout.write(
      `  ${C.dim}Repair it with ${C.reset}${C.cyan}kortix sandboxes fix${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

async function sandboxesBuild(
  client: Client,
  base: string,
  slug: string | undefined,
): Promise<number> {
  if (!slug) return missing('a template slug');
  // Resolve a slug to a project-scoped template_id (needed for PATCH/DELETE/build).
  const id =
    (await client.get<{ items: SandboxTemplate[] }>(`${base}/sandbox-templates`)).items.find(
      (t) => t.slug === slug,
    )?.template_id ?? null;
  if (!id) {
    process.stderr.write(`${status.err(`No project-scoped template "${slug}" to build.`)}\n`);
    return 1;
  }
  await client.post(`${base}/sandbox-templates/${id}/build`);
  process.stdout.write(`${status.ok(`Build started for ${C.bold}${slug}${C.reset}`)}\n`);
  return 0;
}

async function sandboxesRebuild(
  client: Client,
  base: string,
  slug: string | undefined,
): Promise<number> {
  if (!slug) return missing('a template slug');
  const resp = await client.post<{ deleted_existing: boolean; snapshot_name: string }>(
    `${base}/snapshots/rebuild`,
    { slug },
  );
  process.stdout.write(
    `${status.ok(`Rebuild started for ${C.bold}${slug}${C.reset}${resp.deleted_existing ? ' (old snapshot deleted)' : ''}`)}\n`,
  );
  return 0;
}

// ── Local kortix.yaml `[[sandbox.templates]]` edits (source of truth) ────────────────

function sandboxAddLocal(slug: string | undefined, f: Flags): number {
  if (!slug) return missing('a template slug');
  if (!f.image && !f.dockerfile) return missing('--image or --dockerfile');
  if (f.image && f.dockerfile) return fail('Pass only one of --image / --dockerfile.');
  try {
    if (arrayEntryExists('sandbox.templates', 'slug', slug)) {
      process.stderr.write(
        `${status.err(`A [[sandbox.templates]] "${slug}" already exists in kortix.yaml.`)}\n`,
      );
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
      `${status.ok(`Added [[sandbox.templates]] ${C.bold}${slug}${C.reset} to kortix.yaml`)} ${C.dim}— \`kortix ship\` builds it.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

function sandboxUpdateLocal(slug: string | undefined, f: Flags): number {
  if (!slug) return missing('a template slug');
  try {
    if (!arrayEntryExists('sandbox.templates', 'slug', slug)) {
      process.stderr.write(
        `${status.err(`No [[sandbox.templates]] "${slug}" in kortix.yaml (platform/UI templates aren't file-based).`)}\n`,
      );
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
      process.stderr.write(`${status.err(`No [[sandbox.templates]] "${slug}" in kortix.yaml.`)}\n`);
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
  const color = ready
    ? C.green
    : state === 'error'
      ? C.red
      : state === 'missing'
        ? C.faded
        : C.yellow;
  return `${color}${pad(state, 11)}${C.reset}`;
}
