import {
  emitJson,
  type resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

// ── Sandbox provider pin ────────────────────────────────────────────────────
// PATCH /projects/:id/sandbox-provider (project-settings.ts) answers with a TAGGED
// UNION, both arms HTTP 200: `kind:'project'` when the switch applied
// immediately, `kind:'preparation'` when a snapshot must be built on the target
// provider first. GET /projects/:id/sandbox-provider/transition (project-settings.ts)
// polls that preparation — it takes no query params and always reports the
// project's latest transition plus the last 10.

// ── Sandbox provider pin ────────────────────────────────────────────────────
// PATCH /projects/:id/sandbox-provider (project-settings.ts) answers with a TAGGED
// UNION, both arms HTTP 200: `kind:'project'` when the switch applied
// immediately, `kind:'preparation'` when a snapshot must be built on the target
// provider first. GET /projects/:id/sandbox-provider/transition (project-settings.ts)
// polls that preparation — it takes no query params and always reports the
// project's latest transition plus the last 10.

/** apps/api/src/services/sandboxes/provider-transition/provider-transition-core.ts:10. */
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

type SandboxProviderPatchResult = ({ kind: 'project' } & ProjectProviderFields) | PreparationView;

interface ProjectProviderFields {
  project_id: string;
  name?: string;
  default_sandbox_provider?: string | null;
  available_sandbox_providers?: string[];
}

// ── Sandbox provider pin ────────────────────────────────────────────────────

type Client = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>['client'];

export async function sandboxProvider(
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
    process.stdout.write(
      `\n  active   ${C.bold}${state.active_provider ?? 'platform default'}${C.reset}\n`,
    );
    if (!state.latest) {
      process.stdout.write(`  ${C.dim}No provider transition on record.${C.reset}\n\n`);
      return 0;
    }
    process.stdout.write(
      `  ${C.dim}${pad('STATUS', 11)}  ${pad('FROM', 10)}  ${pad('TO', 10)}  REQUESTED${C.reset}\n`,
    );
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

  // `provider: null` is how the API clears the pin (project-settings.ts —
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
