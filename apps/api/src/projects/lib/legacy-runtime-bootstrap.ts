/**
 * Legacy runtime bootstrap — converge a sandbox whose daemon predates the
 * self-updating runtime (#6673/#6676, 2026-08-20).
 *
 * THE PROBLEM. Runtime convergence is pull-only: the daemon reads
 * `/v1/runtime-assets/manifest` at boot and stages its own replacement for the
 * supervising entrypoint to install. A daemon built before that code existed
 * never pulls, restart/resume keep the same VM, and warm-fork keeps the same
 * disk — so a box provisioned before 2026-08-20 keeps its 2026-07 daemon,
 * OpenCode and CLI forever. Live consequence (prod, 2026-09-01): every session
 * with history from before OpenCode's 48-bit message-id rollover
 * (2026-08-14 11:19 UTC) on OpenCode < 1.18.15 stores each prompt, exits its
 * loop at step 0 and never calls a model; the fix shipped upstream in 1.18.15,
 * and the pinned 1.18.23 never reached those boxes.
 *
 * THE MECHANISM. The control plane cannot ask the old daemon to replace
 * itself, so it goes through the PROVIDER's exec channel (Platinum `/exec`,
 * Daytona toolbox, E2B commands — `SandboxProvider.exec`), which is
 * independent of the in-box daemon, and runs one idempotent script that:
 *   1. reads the box's own API URL + sandbox token from /etc/environment (no
 *      secret crosses the control plane; the box converges on the API it
 *      already talks to, exactly like a current daemon);
 *   2. fetches THAT API's runtime-assets manifest, downloads the agent binary
 *      and the supervising entrypoint, and verifies both sha256s;
 *   3. stages the agent as `/opt/kortix/agent.next` (+ `.sha256`) — the exact
 *      slot the supervisor promotes on launch, with its crash-loop rollback to
 *      the baked binary intact — and installs the entrypoint atomically,
 *      keeping `kortix-entrypoint.legacy`;
 *   4. relaunches the runtime. On Platinum pt-init runs the image entrypoint
 *      once and never respawns it, so the script stops the legacy chain and
 *      starts `/sbin/pt-app` detached. Daytona and E2B re-run the entrypoint
 *      on every start, so staging alone converges them at the next wake.
 * The new daemon then converges OpenCode, CLI and skills by itself — this
 * module installs a supervisor and a current daemon, nothing else.
 *
 * SAFETY. Only an idle runtime is touched (OpenCode `/session/status` must be
 * empty). Every attempt is stamped in sandbox metadata with a cooldown and a
 * budget, so a box that cannot be converged is retried a bounded number of
 * times per API build and then left for a human — visible in the metadata
 * and in the audit ledger, never silent. The script restores the legacy
 * entrypoint and relaunches the old chain if the new daemon does not answer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProviderName, SandboxExecResult } from '../../platform/providers';

/**
 * The in-box script ships as a sidecar file, not a template literal: bash is
 * full of `${…}` and backticks, and a JS string is the wrong place to review
 * shell. Read once per process; the API image copies src/ wholesale.
 */
let scriptTemplate: string | null = null;
function loadScriptTemplate(): string {
  if (scriptTemplate === null) {
    scriptTemplate = readFileSync(
      fileURLToPath(new URL('./legacy-runtime-bootstrap.sh', import.meta.url)),
      'utf8',
    );
  }
  return scriptTemplate;
}

export const LEGACY_BOOTSTRAP_METADATA_KEY = 'legacyRuntimeBootstrap';
export const LEGACY_CHECK_METADATA_KEY = 'legacyRuntimeCheck';

/** Re-check a box that last looked current after this long. */
export const LEGACY_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** Wait this long after a failed attempt before the next one. */
export const LEGACY_BOOTSTRAP_COOLDOWN_MS = 30 * 60 * 1000;
/** Attempts per manifest build before the box is left for a human. */
export const LEGACY_BOOTSTRAP_MAX_ATTEMPTS = 3;
/** A `running` stamp older than this is a crashed attempt, not a live one. */
export const LEGACY_BOOTSTRAP_STALE_RUNNING_MS = 20 * 60 * 1000;
/** Budget for the in-box script (downloads ~100 MB + relaunch + health wait). */
export const LEGACY_BOOTSTRAP_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
/** After the relaunch, how long the new daemon may take to report a converged, serving OpenCode. */
export const LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS = 8 * 60 * 1000;
export const LEGACY_BOOTSTRAP_POLL_MS = 5_000;

/** OpenCode home on the box: 'auto' = detect from the running OpenCode / on-disk data (image generations differ). */
export const LEGACY_OPENCODE_HOME = 'auto';

export type RuntimeClass = 'legacy' | 'current' | 'not-ok' | 'unreachable';

export interface RuntimeClassification {
  klass: RuntimeClass;
  /** `runtime.build` the box reports having converged to, when it reports one. */
  runtimeBuild: number | null;
  /** `opencode` field of health: 'ok' | 'starting' | ... */
  opencode: string | null;
  /** `runtime.components.opencode` outcome when reported. */
  opencodeComponent: string | null;
}

/**
 * A daemon that answers /kortix/health without a `runtime` block was built
 * before convergence existed. Health is unauthenticated and always 200 on a
 * daemon, so a null body means the box could not be reached, not "old".
 */
export function classifyDaemonHealth(body: unknown): RuntimeClassification {
  if (!body || typeof body !== 'object') {
    return { klass: 'unreachable', runtimeBuild: null, opencode: null, opencodeComponent: null };
  }
  const h = body as Record<string, unknown>;
  const opencode = typeof h.opencode === 'string' ? h.opencode : null;
  if (h.daemon !== 'ok') {
    return { klass: 'not-ok', runtimeBuild: null, opencode, opencodeComponent: null };
  }
  const runtime = h.runtime;
  if (!runtime || typeof runtime !== 'object') {
    return { klass: 'legacy', runtimeBuild: null, opencode, opencodeComponent: null };
  }
  const r = runtime as Record<string, unknown>;
  const components = (r.components ?? {}) as Record<string, unknown>;
  return {
    klass: 'current',
    runtimeBuild: typeof r.build === 'number' ? r.build : null,
    opencode,
    opencodeComponent:
      typeof components.opencode === 'string' ? (components.opencode as string) : null,
  };
}

export type RelaunchStrategy = 'pt-app' | 'next-start';

/**
 * How a provider re-runs the image entrypoint. Platinum's pt-init launches it
 * once and never again (the VM survives its exit), so the script must relaunch
 * in place. Daytona and E2B run the entrypoint on every sandbox start.
 */
export function relaunchStrategyFor(provider: ProviderName | string): RelaunchStrategy | null {
  switch (provider) {
    case 'platinum':
      return 'pt-app';
    case 'daytona':
    case 'e2b':
      return 'next-start';
    default:
      return null;
  }
}

export interface RenderScriptOptions {
  relaunch: RelaunchStrategy;
  opencodeHome?: string;
  /** Seconds the script waits for the relaunched daemon before it restores the legacy chain. */
  healthWaitS?: number;
  /**
   * The entrypoint text, for a box whose API does not serve the `entrypoint`
   * asset yet. The box's own manifest wins whenever it has one.
   */
  entrypointSource?: string;
  /** Fleet pnpm version (packages/shared runtime-versions.json); the script downgrades for an older Node. */
  pnpmVersion?: string;
  /** A freshly minted session PAT to install as the box's KORTIX_TOKEN; empty = keep. */
  kortixToken?: string;
}

/**
 * The in-box script. Bash, root, no jq assumed (python3 when present, sed
 * otherwise), no shell evaluation of anything read from the environment.
 * Prints exactly one JSON line on stdout as its last line; everything else
 * goes to stderr and /var/log/kortix-legacy-bootstrap.log.
 */
export function renderLegacyBootstrapScript(opts: RenderScriptOptions): string {
  const opencodeHome = opts.opencodeHome ?? LEGACY_OPENCODE_HOME;
  const healthWaitS = Math.max(30, Math.floor(opts.healthWaitS ?? 150));
  if (opencodeHome !== 'auto' && !/^\/[A-Za-z0-9_./-]+$/.test(opencodeHome)) throw new Error('unsafe opencodeHome');
  const template = loadScriptTemplate();
  const embedded = opts.entrypointSource ? Buffer.from(opts.entrypointSource, 'utf8').toString('base64') : '';
  const pnpmVersion = opts.pnpmVersion ?? '';
  if (!/^[0-9A-Za-z.-]*$/.test(pnpmVersion)) throw new Error('unsafe pnpmVersion');
  const kortixToken = opts.kortixToken ?? '';
  if (!/^(kortix_pat_[A-Za-z0-9_-]+)?$/.test(kortixToken)) throw new Error('unsafe kortixToken');
  for (const placeholder of ['__OPENCODE_HOME__', '__RELAUNCH__', '__HEALTH_WAIT_S__', '__ENTRYPOINT_B64__', '__PNPM_VERSION__', '__KORTIX_TOKEN__']) {
    if (!template.includes(placeholder)) throw new Error(`bootstrap script template lacks ${placeholder}`);
  }
  return template
    .replace('__OPENCODE_HOME__', opencodeHome)
    .replace('__RELAUNCH__', opts.relaunch)
    .replace('__HEALTH_WAIT_S__', String(healthWaitS))
    .replace('__ENTRYPOINT_B64__', embedded)
    .replace('__PNPM_VERSION__', pnpmVersion)
    .replace('__KORTIX_TOKEN__', kortixToken);
}

/** The provider `exec` argv: the script travels base64 so no quoting layer can touch it. */
export function bootstrapExecCommand(script: string): string[] {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return [
    'bash',
    '-c',
    `printf '%s' '${b64}' | base64 -d > /tmp/kx-legacy-bootstrap.sh && bash /tmp/kx-legacy-bootstrap.sh`,
  ];
}

export interface ScriptReport {
  ok: boolean;
  stage: string;
  error?: string;
  agent_sha256?: string;
  entrypoint_sha256?: string;
  previous_opencode?: string;
  token_rotated?: boolean;
}

/** The script's last stdout line is its report. Anything else is a transport failure. */
export function parseScriptReport(result: SandboxExecResult): ScriptReport | null {
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.ok === 'boolean' && typeof parsed.stage === 'string') {
        return parsed as unknown as ScriptReport;
      }
    } catch {
      /* not the report line */
    }
  }
  return null;
}

export type LegacyBootstrapState = 'running' | 'converged' | 'staged' | 'failed';

export interface LegacyBootstrapRecord {
  state: LegacyBootstrapState;
  attempts: number;
  /** Manifest build the attempts were counted against; a new build resets the budget. */
  manifestBuild: number | null;
  lastAttemptAt: string;
  finishedAt?: string;
  reason?: string;
  from?: { opencode?: string | null };
  to?: { agentSha256?: string; entrypointSha256?: string; runtimeBuild?: number | null };
  error?: string;
}

export interface LegacyCheckRecord {
  at: string;
  klass: RuntimeClass;
}

export type LegacyBootstrapOutcome =
  | 'not-legacy'
  | 'unreachable'
  | 'skipped-recent-check'
  | 'skipped-cooldown'
  | 'skipped-exhausted'
  | 'skipped-in-progress'
  | 'skipped-busy'
  | 'skipped-unsupported'
  | 'staged'
  | 'converged'
  | 'failed';

export interface LegacyBootstrapInput {
  sandboxId: string;
  externalId: string;
  provider: ProviderName | string;
  metadata: Record<string, unknown> | null | undefined;
  /** Who asked: 'reaper' | 'sweep' | ... — recorded, never acted on. */
  reason: string;
  /** Skip the recent-check TTL (an operator sweep wants the truth now). */
  force?: boolean;
  /** Internal: this call is the relaunch pass after an OpenCode install. */
  postInstallPass?: boolean;
}

export interface LegacyBootstrapDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Current manifest build of THIS control plane, for the attempt budget. */
  manifestBuild: () => Promise<number | null>;
  /** Daemon /kortix/health JSON, or null when unreachable. */
  fetchHealth: () => Promise<unknown>;
  /** OpenCode /session/status JSON (empty object = idle), or null when unreachable. */
  fetchOpencodeStatus: () => Promise<Record<string, unknown> | null>;
  exec: (command: string[], timeoutMs: number) => Promise<SandboxExecResult>;
  /** Entrypoint text to embed for an API that predates the asset; null when unavailable. */
  entrypointSource?: () => string | null;
  /** Fleet pnpm version to install on a box whose pnpm predates `--allow-build`. */
  pnpmVersion?: () => string | null;
  /**
   * When the box still carries the pre-2026-08 `kortix_sb_` service key as its
   * KORTIX_TOKEN, mint a session PAT, store it as the sandbox service key, and
   * return the secret for the script to install. Null = nothing to rotate.
   */
  rotateKortixToken?: () => Promise<string | null>;
  /**
   * The box reported whether it installed the rotated token (`null` = the
   * script's report never arrived). The wiring stores the new service key
   * only once the box provably holds it, or verifies by probing.
   */
  commitKortixToken?: (secret: string, rotatedOnBox: boolean | null) => Promise<void>;
  patchMetadata: (patch: Record<string, unknown>) => Promise<void>;
  audit: (event: {
    outcome: 'success' | 'failure';
    phase: string;
    summary: Record<string, unknown>;
    error?: string;
  }) => Promise<void>;
  log: (message: string, context?: Record<string, unknown>) => void;
}

export interface LegacyBootstrapResult {
  outcome: LegacyBootstrapOutcome;
  detail?: string;
  classification?: RuntimeClassification;
}

function readRecord(metadata: Record<string, unknown> | null | undefined): LegacyBootstrapRecord | null {
  const raw = metadata?.[LEGACY_BOOTSTRAP_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== 'string' || typeof r.lastAttemptAt !== 'string') return null;
  return {
    state: r.state as LegacyBootstrapState,
    attempts: typeof r.attempts === 'number' ? r.attempts : 0,
    manifestBuild: typeof r.manifestBuild === 'number' ? r.manifestBuild : null,
    lastAttemptAt: r.lastAttemptAt,
    finishedAt: typeof r.finishedAt === 'string' ? r.finishedAt : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
  };
}

function readCheck(metadata: Record<string, unknown> | null | undefined): LegacyCheckRecord | null {
  const raw = metadata?.[LEGACY_CHECK_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== 'string' || typeof r.klass !== 'string') return null;
  return { at: r.at, klass: r.klass as RuntimeClass };
}

function opencodeIdle(status: Record<string, unknown> | null): boolean {
  if (!status) return false;
  return Object.keys(status).length === 0;
}

/**
 * Decide, and when warranted do, the bootstrap for one sandbox. Pure over
 * `deps`; every side effect is injected so the policy is unit-testable and the
 * wiring (DB, provider, ingress, audit) lives in one place.
 */
export async function bootstrapLegacyRuntime(
  input: LegacyBootstrapInput,
  deps: LegacyBootstrapDeps,
): Promise<LegacyBootstrapResult> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const strategy = relaunchStrategyFor(input.provider);
  if (!strategy) return { outcome: 'skipped-unsupported', detail: `provider ${input.provider}` };

  const record = readRecord(input.metadata);
  const check = readCheck(input.metadata);

  // Cheap gates first — none of these touch the box.
  if (record?.state === 'running') {
    const startedMs = Date.parse(record.lastAttemptAt);
    if (Number.isFinite(startedMs) && nowMs - startedMs < LEGACY_BOOTSTRAP_STALE_RUNNING_MS) {
      return { outcome: 'skipped-in-progress' };
    }
  }
  if (!input.force && check && check.klass === 'current') {
    const atMs = Date.parse(check.at);
    if (Number.isFinite(atMs) && nowMs - atMs < LEGACY_CHECK_TTL_MS) {
      return { outcome: 'skipped-recent-check' };
    }
  }

  const health = await deps.fetchHealth();
  const classification = classifyDaemonHealth(health);
  if (classification.klass === 'unreachable' || classification.klass === 'not-ok') {
    return { outcome: 'unreachable', classification };
  }
  if (classification.klass === 'current' && classification.runtimeBuild === null) {
    // A current daemon that has not finished (or has failed) its first
    // convergence pass: not legacy, nothing for this module to do yet.
    return { outcome: 'not-legacy', detail: 'daemon current, convergence pending', classification };
  }
  if (classification.klass === 'current' && input.force) {
    // Operator-forced re-run on a current daemon: its OpenCode install failed
    // (a 2026-07 image's pnpm 8, for one), or an operator wants the chain
    // relaunched so the daemon re-detects a freshly installed binary. The
    // script is idempotent — agent and entrypoint are skipped when already at
    // the manifest — so a re-run is "fix the floor, relaunch, converge again".
    deps.log('forced re-run on a current daemon', {
      sandboxId: input.sandboxId,
      opencodeComponent: classification.opencodeComponent,
    });
  } else if (classification.klass === 'current') {
    const patch: Record<string, unknown> = {
      [LEGACY_CHECK_METADATA_KEY]: { at: nowIso, klass: 'current' } satisfies LegacyCheckRecord,
    };
    // A bootstrap that was mid-flight is proven done by a current daemon.
    if (record && record.state !== 'converged') {
      patch[LEGACY_BOOTSTRAP_METADATA_KEY] = {
        ...record,
        state: 'converged',
        finishedAt: nowIso,
        to: { ...(record.to ?? {}), runtimeBuild: classification.runtimeBuild },
      } satisfies LegacyBootstrapRecord;
    }
    await deps.patchMetadata(patch);
    return { outcome: 'not-legacy', classification };
  }

  // Legacy. Budget and cooldown are per manifest build: a new deploy earns a
  // fresh set of attempts, a box that keeps failing on the same build does not.
  const build = await deps.manifestBuild();
  const sameBuild = record?.manifestBuild === build;
  const attempts = sameBuild && record ? record.attempts : 0;
  if (record && sameBuild && record.state === 'failed') {
    if (attempts >= LEGACY_BOOTSTRAP_MAX_ATTEMPTS && !input.force) {
      return { outcome: 'skipped-exhausted', detail: `${attempts} attempts on build ${build}`, classification };
    }
    const lastMs = Date.parse(record.lastAttemptAt);
    if (!input.force && Number.isFinite(lastMs) && nowMs - lastMs < LEGACY_BOOTSTRAP_COOLDOWN_MS) {
      return { outcome: 'skipped-cooldown', classification };
    }
  }
  if (record && sameBuild && record.state === 'staged') {
    // Daytona/E2B: staged and waiting for the provider's next start. Nothing
    // to redo until a current daemon proves it or the build moves on.
    return { outcome: 'staged', detail: 'already staged; converges at next start', classification };
  }

  // Never under a running turn. OpenCode's own busy state is the authority —
  // the ledger can hold a zombie turn on exactly the boxes this exists for.
  const status = await deps.fetchOpencodeStatus();
  if (!opencodeIdle(status)) {
    return { outcome: 'skipped-busy', detail: status ? 'opencode busy' : 'opencode unreachable', classification };
  }

  const running: LegacyBootstrapRecord = {
    state: 'running',
    attempts: attempts + 1,
    manifestBuild: build,
    lastAttemptAt: nowIso,
    reason: input.reason,
    from: { opencode: classification.opencode },
  };
  await deps.patchMetadata({
    [LEGACY_BOOTSTRAP_METADATA_KEY]: running,
    [LEGACY_CHECK_METADATA_KEY]: { at: nowIso, klass: 'legacy' } satisfies LegacyCheckRecord,
  });
  deps.log('legacy runtime bootstrap starting', {
    sandboxId: input.sandboxId,
    externalId: input.externalId,
    provider: input.provider,
    attempt: running.attempts,
    strategy,
    reason: input.reason,
  });

  const finish = async (
    state: LegacyBootstrapState,
    extra: Partial<LegacyBootstrapRecord>,
    outcome: LegacyBootstrapOutcome,
    detail?: string,
  ): Promise<LegacyBootstrapResult> => {
    const finished: LegacyBootstrapRecord = {
      ...running,
      ...extra,
      state,
      finishedAt: new Date(deps.now()).toISOString(),
    };
    await deps.patchMetadata({ [LEGACY_BOOTSTRAP_METADATA_KEY]: finished });
    await deps.audit({
      outcome: state === 'failed' ? 'failure' : 'success',
      phase: state,
      summary: {
        attempt: finished.attempts,
        strategy,
        reason: input.reason,
        from: finished.from ?? null,
        to: finished.to ?? null,
        detail: detail ?? null,
      },
      error: finished.error,
    });
    deps.log(`legacy runtime bootstrap ${state}`, {
      sandboxId: input.sandboxId,
      externalId: input.externalId,
      outcome,
      detail,
      error: finished.error,
    });
    return { outcome, detail, classification };
  };

  let execResult: SandboxExecResult;
  // Token rotation only where the box's own environment is what the daemon
  // boots from (Platinum: /etc/environment via pt-init). Daytona and E2B hand
  // the daemon its env from the provider on every start, so a rotated secret
  // in the box would diverge from what the daemon actually runs with.
  const kortixToken =
    strategy === 'pt-app' ? ((await deps.rotateKortixToken?.()) ?? undefined) : undefined;
  const commitToken = async (rotatedOnBox: boolean | null) => {
    if (!kortixToken) return;
    await deps.commitKortixToken?.(kortixToken, rotatedOnBox);
  };
  try {
    execResult = await deps.exec(
      bootstrapExecCommand(
        renderLegacyBootstrapScript({
          relaunch: strategy,
          entrypointSource: deps.entrypointSource?.() ?? undefined,
          pnpmVersion: deps.pnpmVersion?.() ?? undefined,
          kortixToken,
        }),
      ),
      LEGACY_BOOTSTRAP_EXEC_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await commitToken(null);
    return finish('failed', { error: `exec: ${message}`.slice(0, 500) }, 'failed', 'provider exec failed');
  }
  const report = parseScriptReport(execResult);
  await commitToken(report ? report.token_rotated === true : null);
  if (!report) {
    const tail = (execResult.stderr || execResult.stdout).trim().slice(-400);
    return finish(
      'failed',
      { error: `no report (exit ${execResult.exitCode}): ${tail}`.slice(0, 500) },
      'failed',
      'script produced no report',
    );
  }
  if (!report.ok) {
    return finish(
      'failed',
      { error: `${report.stage}: ${report.error ?? 'unknown'}`.slice(0, 500) },
      'failed',
      `script failed at ${report.stage}`,
    );
  }
  const to = { agentSha256: report.agent_sha256, entrypointSha256: report.entrypoint_sha256 };
  if (report.stage === 'staged') {
    return finish('staged', { to }, 'staged', 'staged; converges at the provider\'s next start');
  }

  // Relaunched. The new daemon must now report a runtime block AND a serving
  // OpenCode — the convergence pass installs the pinned OpenCode at boot, and
  // "done" means a prompt would work, not that a process is listening.
  const deadline = deps.now() + LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS;
  let last: RuntimeClassification | null = null;
  while (deps.now() < deadline) {
    const after = classifyDaemonHealth(await deps.fetchHealth());
    last = after;
    // The daemon reports its own convergence pass. `failed` is final for this
    // boot — waiting would not change it — and the reason lives in /kortix/diag.
    if (after.klass === 'current' && after.opencodeComponent === 'failed') {
      return finish(
        'failed',
        { to: { ...to, runtimeBuild: after.runtimeBuild }, error: 'daemon converged but its OpenCode install failed (see /kortix/diag runtime.reasons.opencode)' },
        'failed',
        'opencode convergence failed',
      );
    }
    if (
      after.klass === 'current' &&
      after.opencode === 'ok' &&
      after.runtimeBuild !== null &&
      (after.opencodeComponent === 'current' || after.opencodeComponent === 'updated')
    ) {
      await deps.patchMetadata({
        [LEGACY_CHECK_METADATA_KEY]: { at: new Date(deps.now()).toISOString(), klass: 'current' } satisfies LegacyCheckRecord,
      });
      const converged = await finish('converged', { to: { ...to, runtimeBuild: after.runtimeBuild } }, 'converged');
      // `updated` = this daemon installed OpenCode during its boot pass. Daemon
      // builds before the restart re-detection fix keep spawning the binary
      // they memoised at boot, so one more relaunch is what makes the installed
      // OpenCode the running one. Idempotent: agent, entrypoint and token are
      // already at the manifest, only the chain restarts.
      if (after.opencodeComponent === 'updated' && !input.postInstallPass) {
        deps.log('relaunching once more so the installed OpenCode is the running one', {
          sandboxId: input.sandboxId,
        });
        const finishedRecord: LegacyBootstrapRecord = {
          ...running,
          state: 'converged',
          to: { ...to, runtimeBuild: after.runtimeBuild },
          finishedAt: new Date(deps.now()).toISOString(),
        };
        return bootstrapLegacyRuntime(
          {
            ...input,
            force: true,
            postInstallPass: true,
            reason: `${input.reason}:post-install-relaunch`,
            metadata: { ...(input.metadata ?? {}), [LEGACY_BOOTSTRAP_METADATA_KEY]: finishedRecord },
          },
          deps,
        );
      }
      return converged;
    }
    await deps.sleep(LEGACY_BOOTSTRAP_POLL_MS);
  }
  return finish(
    'failed',
    {
      to,
      error: `relaunched but not converged within budget (last: ${last?.klass ?? 'unreachable'}/${last?.opencode ?? '-'})`,
    },
    'failed',
    'converge timeout',
  );
}
