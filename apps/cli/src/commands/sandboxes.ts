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
import { C, help, pad, status } from '../style.ts';
import { runSandboxBuildLocal } from './sandboxes-local.ts';

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

// ── Sandbox provider pin ────────────────────────────────────────────────────
// PATCH /projects/:id/sandbox-provider (r6.ts:1483) answers with a TAGGED
// UNION, both arms HTTP 200: `kind:'project'` when the switch applied
// immediately, `kind:'preparation'` when a snapshot must be built on the target
// provider first. GET /projects/:id/sandbox-provider/transition (r6.ts:1554)
// polls that preparation — it takes no query params and always reports the
// project's latest transition plus the last 10.

/** apps/api/src/projects/provider-transition/provider-transition-core.ts:10. */
const LIVE_TRANSITION_STATUSES = ['pending', 'building', 'ready', 'activating'] as const;

interface TransitionView {
  transition_id: string | null;
  project_id: string;
  status: string;
  source_provider: string | null;
  target_provider: string | null;
  generation: number | null;
  label: string;
  error_class: string | null;
  requested_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  immediate: boolean;
}

interface TransitionState {
  active_provider: string | null;
  latest: TransitionView | null;
  history: TransitionView[];
}

/** The `kind:'preparation'` arm of the PATCH response (app.ts:63). */
interface PreparationView extends TransitionView {
  kind: 'preparation';
  active_provider: string | null;
  last_error: string | null;
}

type SandboxProviderPatchResult =
  | ({ kind: 'project' } & ProjectProviderFields)
  | PreparationView;

interface ProjectProviderFields {
  project_id: string;
  name?: string;
  default_sandbox_provider?: string | null;
  available_sandbox_providers?: string[];
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

export async function runSandboxes(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // The root help promises `kortix <cmd> <subcommand> --help`. None of the
  // subcommands below own dedicated help text, so without this a bare
  // `--help` falls through as an ordinary positional arg and the command
  // runs (or fails on auth) instead of printing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const f: Record<string, string | undefined> = {};
  let json = false;
  let local = false;
  let clear = false;
  try {
    json = takeFlagBool(rest, ['--json']);
    local = takeFlagBool(rest, ['--local']);
    clear = takeFlagBool(rest, ['--clear', '--unpin']);
    f.timeout = takeFlagValue(rest, ['--timeout']);
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
  if (sub === 'build' && local) return runSandboxBuildLocal(rest, { json });
  if (local) {
    // `--local` was consumed above, so an unhandled one would otherwise vanish
    // and the command would quietly do the CLOUD thing instead — `sandboxes
    // rebuild --local` silently rebuilding a live snapshot is not a mistake
    // anyone should be able to make by typo.
    process.stderr.write(`${status.err(`--local only applies to \`sandboxes build\`, not "${sub}".`)}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
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
          process.stdout.write(`  ${C.red}current failure:${C.reset} ${trim(currentFailure.error?.split('\n')[0] ?? 'unknown', 80)}\n`);
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
      case 'provider':
        return await sandboxProvider(ctx.client, base, positional[0], {
          clear,
          json,
          timeoutSec: f.timeout ? Number(f.timeout) : 600,
        });
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

// ── Local kortix.yaml `[[sandbox.templates]]` edits (source of truth) ────────────────

function sandboxAddLocal(slug: string | undefined, f: Record<string, string | undefined>): number {
  if (!slug) return missing('a template slug');
  if (!f.image && !f.dockerfile) return missing('--image or --dockerfile');
  if (f.image && f.dockerfile) {
    process.stderr.write(`${status.err('Pass only one of --image / --dockerfile.')}\n`);
    return 2;
  }
  try {
    if (arrayEntryExists('sandbox.templates', 'slug', slug)) {
      process.stderr.write(`${status.err(`A [[sandbox.templates]] "${slug}" already exists in kortix.yaml.`)}\n`);
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

function sandboxUpdateLocal(slug: string | undefined, f: Record<string, string | undefined>): number {
  if (!slug) return missing('a template slug');
  try {
    if (!arrayEntryExists('sandbox.templates', 'slug', slug)) {
      process.stderr.write(`${status.err(`No [[sandbox.templates]] "${slug}" in kortix.yaml (platform/UI templates aren't file-based).`)}\n`);
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

// ── Sandbox provider pin ────────────────────────────────────────────────────

type Client = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>['client'];

async function sandboxProvider(
  client: Client,
  base: string,
  arg: string | undefined,
  opts: { clear: boolean; json: boolean; timeoutSec: number },
): Promise<number> {
  // `provider status` reads the transition log; a bare `provider` reads the pin.
  if (arg === 'status' || arg === 'transition') {
    const state = await client.get<TransitionState>(`${base}/sandbox-provider/transition`);
    if (opts.json) {
      emitJson(state);
      return 0;
    }
    process.stdout.write(`\n  active   ${C.bold}${state.active_provider ?? 'platform default'}${C.reset}\n`);
    if (!state.latest) {
      process.stdout.write(`  ${C.dim}No provider transition on record.${C.reset}\n\n`);
      return 0;
    }
    process.stdout.write(`  ${C.dim}${pad('STATUS', 11)}  ${pad('FROM', 10)}  ${pad('TO', 10)}  REQUESTED${C.reset}\n`);
    for (const t of state.history.length > 0 ? state.history : [state.latest]) {
      process.stdout.write(
        `  ${transitionCell(t.status)}  ${pad(t.source_provider ?? '—', 10)}  ` +
          `${pad(t.target_provider ?? '—', 10)}  ${C.faded}${(t.requested_at ?? '').slice(0, 19).replace('T', ' ')}${C.reset}` +
          `${t.error_class ? ` ${C.red}${t.error_class}${C.reset}` : ''}\n`,
      );
    }
    process.stdout.write('\n');
    return 0;
  }

  if (!arg && !opts.clear) {
    const project = await client.get<ProjectProviderFields>(base);
    if (opts.json) {
      emitJson({
        default_sandbox_provider: project.default_sandbox_provider ?? null,
        available_sandbox_providers: project.available_sandbox_providers ?? [],
      });
      return 0;
    }
    const available = project.available_sandbox_providers ?? [];
    process.stdout.write(
      `\n  pinned     ${project.default_sandbox_provider ? `${C.bold}${project.default_sandbox_provider}${C.reset}` : `${C.faded}none — follows the platform default${C.reset}`}\n` +
        `  available  ${C.dim}${available.length > 0 ? available.join(', ') : 'none enabled on this host'}${C.reset}\n\n` +
        `  ${C.dim}Pin one: ${C.reset}${C.cyan}kortix sandboxes provider <name>${C.reset}\n\n`,
    );
    return 0;
  }

  // `provider: null` is how the API clears the pin (r6.ts:1508 —
  // null/undefined/'' all normalize to "clear").
  const result = await client.patch<SandboxProviderPatchResult>(`${base}/sandbox-provider`, {
    provider: opts.clear ? null : arg,
  });

  if (result.kind === 'project') {
    if (opts.json) {
      emitJson(result);
      return 0;
    }
    process.stdout.write(
      opts.clear
        ? `${status.ok('Pin cleared')} ${C.dim}— new sessions follow the platform default.${C.reset}\n`
        : `${status.ok(`Pinned to ${C.bold}${result.default_sandbox_provider ?? arg}${C.reset}`)} ${C.dim}(applies to new sessions)${C.reset}\n`,
      );
    return 0;
  }

  // Preparation: the target provider has no snapshot yet. Poll until the
  // transition leaves the live set, or the caller's deadline passes.
  if (opts.json && opts.timeoutSec <= 0) {
    emitJson(result);
    return 0;
  }
  if (!opts.json) {
    process.stdout.write(
      `${status.info(`Preparing ${C.bold}${result.target_provider ?? arg}${C.reset} — building its snapshot first`)}\n` +
        `  ${C.dim}${result.label}${C.reset}\n`,
    );
  }
  return pollTransition(client, base, opts, result.status);
}

async function pollTransition(
  client: Client,
  base: string,
  opts: { json: boolean; timeoutSec: number },
  initialStatus: string,
): Promise<number> {
  const deadline = Date.now() + opts.timeoutSec * 1000;
  let last = initialStatus;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let state: TransitionState;
    try {
      state = await client.get<TransitionState>(`${base}/sandbox-provider/transition`);
    } catch {
      // A transient poll failure must not abort a build that is still running.
      if (Date.now() >= deadline) break;
      continue;
    }
    const latest = state.latest;
    const now = latest?.status ?? 'unknown';
    if (!opts.json && now !== last) {
      process.stdout.write(`  ${C.dim}${now}…${C.reset}\n`);
      last = now;
    }
    if (!(LIVE_TRANSITION_STATUSES as readonly string[]).includes(now)) {
      if (opts.json) {
        emitJson(state);
        return now === 'failed' || now === 'cancelled' ? 1 : 0;
      }
      if (now === 'activated') {
        process.stdout.write(
          `${status.ok(`Now on ${C.bold}${latest?.target_provider ?? state.active_provider ?? '?'}${C.reset}`)}\n`,
        );
        return 0;
      }
      process.stderr.write(
        `${status.err(`Transition ended ${now}${latest?.error_class ? ` (${latest.error_class})` : ''}.`)}\n`,
      );
      return 1;
    }
    if (Date.now() >= deadline) break;
  }
  process.stderr.write(
    `${status.err(`Still ${last} after ${opts.timeoutSec}s.`)} The build keeps running — ` +
      `check it with ${C.cyan}kortix sandboxes provider status${C.reset}.\n`,
  );
  return 1;
}

function transitionCell(state: string): string {
  const color =
    state === 'activated'
      ? C.green
      : state === 'failed' || state === 'cancelled'
        ? C.red
        : state === 'superseded'
          ? C.faded
          : C.yellow;
  return `${color}${pad(state, 11)}${C.reset}`;
}
