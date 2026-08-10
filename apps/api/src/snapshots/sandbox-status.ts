/**
 * The one question every sandbox surface actually answers: *can a session boot
 * right now, and if not, why?*
 *
 * The build log alone cannot answer it. A build row is an append-only record of
 * one past ATTEMPT against one content identity; it is not the state of the
 * image. Deriving "the sandbox is broken" from `builds[0].status === 'failed'`
 * makes a failure immortal — it stays red after the template definition moved
 * on (the row describes an image nobody boots anymore) and after the very same
 * image later became active on the provider (the attempt failed, the image
 * exists). Both produce the same bug: an 11-day-old error presented in the
 * present tense while sessions have been starting fine the whole time.
 *
 * So live provider coverage — observed per provider for the CURRENT content
 * identity — is the primary evidence, and the build log is only ever used to
 * explain a state that coverage has already established. A failed row is
 * "current" only when it names the image we are trying to boot AND that image
 * is absent everywhere the project can route.
 *
 * Pure: no db, no config, no clock. The route injects everything.
 */

/** Which providers a session on this project can land on. */
export interface SandboxStatusCoverage {
  provider: string;
  /** The provider is enabled platform-wide; false means it was never probed. */
  available: boolean;
  status: 'ready' | 'building' | 'failed' | 'not_built' | 'unavailable' | 'unknown';
  launch_ready: boolean;
}

/** The build-log fields this derivation reads. Rows are newest-first. */
export interface SandboxStatusBuild {
  slug: string;
  snapshotName: string;
  status: 'building' | 'ready' | 'failed';
}

export type SandboxRuntimeState =
  /** Every provider this project can route to holds the current image. */
  | 'ready'
  /** The current image is on its way up somewhere. Sessions may wait, not fail. */
  | 'building'
  /** No image yet and nothing failed — the next session start builds one. */
  | 'not_built'
  /** Usable on some routable providers, failed on others: sessions are a coin flip. */
  | 'degraded'
  /** No usable image anywhere the project routes, and the last attempt failed. */
  | 'blocked'
  /** Providers could not be observed. Never render an alert from this. */
  | 'unknown';

export interface SandboxRuntimeStatus<B> {
  state: SandboxRuntimeState;
  /** The content-addressed image the current template definition resolves to. */
  snapshot_name: string | null;
  /**
   * The failure that still describes the image we are trying to boot. Only ever
   * set for `blocked` / `degraded` — i.e. when retrying would hit it again.
   */
  current_failure: B | null;
  /** Newest failed attempt that no longer applies. History, never an alert. */
  stale_failure: B | null;
  stale_reason: StaleFailureReason | null;
  ready_providers: string[];
  building_providers: string[];
  failed_providers: string[];
}

export type StaleFailureReason =
  /** It failed building a previous definition; the current one has moved on. */
  | 'superseded'
  /** Same image, now live on a provider — the attempt failed, the image exists. */
  | 'recovered'
  /** Same image, a newer attempt for it is already running. */
  | 'retrying';

export interface ResolveSandboxStatusInput<B extends SandboxStatusBuild> {
  /** Current content identity of the template sessions boot from. */
  snapshotName: string | null;
  /** Live per-provider observation of `snapshotName`. Null when unobserved. */
  coverage: readonly SandboxStatusCoverage[] | null | undefined;
  /** An explicit project pin. null means Automatic (any enabled provider). */
  selectedProvider: string | null;
  /** Session-template builds for that template, newest attempt first. */
  builds: readonly B[];
}

export function resolveSandboxRuntimeStatus<B extends SandboxStatusBuild>(
  input: ResolveSandboxStatusInput<B>,
): SandboxRuntimeStatus<B> {
  const { snapshotName, selectedProvider } = input;

  // A pinned project only ever lands on its pin, so another provider's state —
  // ready OR failed — says nothing about whether its sessions can start.
  const routable = (input.coverage ?? []).filter(
    (item) => item.available && (!selectedProvider || item.provider === selectedProvider),
  );
  const ready = routable.filter((item) => item.launch_ready);
  const building = routable.filter((item) => item.status === 'building');
  const failed = routable.filter((item) => item.status === 'failed');
  const absent = routable.filter((item) => item.status === 'not_built');

  // Only builds for the image we would boot RIGHT NOW can describe it. A row for
  // any other snapshot name built a definition that no longer exists.
  const currentBuilds = snapshotName
    ? input.builds.filter((build) => build.snapshotName === snapshotName)
    : [];
  const latestCurrent = currentBuilds[0] ?? null;
  const failedCurrentBuild = latestCurrent?.status === 'failed' ? latestCurrent : null;

  const state = resolveState({
    routableCount: routable.length,
    readyCount: ready.length,
    buildingCount: building.length,
    failedCount: failed.length,
    absentCount: absent.length,
    latestCurrentStatus: latestCurrent?.status ?? null,
  });

  const isCurrent = state === 'blocked' || state === 'degraded';
  const currentFailure = isCurrent ? failedCurrentBuild : null;
  const newestFailure = input.builds.find((build) => build.status === 'failed') ?? null;
  const staleFailure = newestFailure && newestFailure !== currentFailure ? newestFailure : null;

  return {
    state,
    snapshot_name: snapshotName,
    current_failure: currentFailure,
    stale_failure: staleFailure,
    stale_reason: staleFailure
      ? staleFailureReason(staleFailure, { snapshotName, state, latestCurrent })
      : null,
    ready_providers: ready.map((item) => item.provider),
    building_providers: building.map((item) => item.provider),
    failed_providers: failed.map((item) => item.provider),
  };
}

function resolveState(counts: {
  routableCount: number;
  readyCount: number;
  buildingCount: number;
  failedCount: number;
  absentCount: number;
  latestCurrentStatus: 'building' | 'ready' | 'failed' | null;
}): SandboxRuntimeState {
  // Nothing observed at all (degraded payload, provider probe skipped). The
  // build log is the only evidence left, and it can only be trusted about the
  // current identity.
  if (counts.routableCount === 0) {
    if (counts.latestCurrentStatus === 'failed') return 'blocked';
    if (counts.latestCurrentStatus === 'building') return 'building';
    return 'unknown';
  }

  const usable = counts.readyCount > 0;
  // Positive evidence that the image is absent or broken somewhere routable.
  // An all-`unknown` probe is NOT evidence — a transient provider blip must
  // never turn into a red "your sandbox is broken".
  const missingEvidence = counts.failedCount > 0 || counts.absentCount > 0;
  const failureEvidence = counts.failedCount > 0 || counts.latestCurrentStatus === 'failed';

  if (!usable && counts.buildingCount === 0 && missingEvidence && failureEvidence) return 'blocked';
  if (usable && counts.failedCount > 0) return 'degraded';
  if (counts.readyCount === counts.routableCount) return 'ready';
  if (counts.buildingCount > 0) return 'building';
  if (counts.absentCount > 0) return 'not_built';
  return 'unknown';
}

function staleFailureReason<B extends SandboxStatusBuild>(
  failure: B,
  ctx: {
    snapshotName: string | null;
    state: SandboxRuntimeState;
    latestCurrent: B | null;
  },
): StaleFailureReason {
  if (!ctx.snapshotName || failure.snapshotName !== ctx.snapshotName) return 'superseded';
  if (ctx.state === 'building' || ctx.latestCurrent?.status === 'building') return 'retrying';
  return 'recovered';
}

/**
 * The template a new session boots by default: the project's declared default
 * (`sandbox.default` in kortix.yaml) when it resolves, else the platform
 * default, which `listTemplatesForWorkspace` sorts first. Everything user-facing
 * must describe THIS template — reporting on some other one is how a healthy
 * project ends up wearing another template's failure.
 */
export function pickPrimaryTemplate<T extends { slug: string }>(
  templates: readonly T[],
  defaultSlug: string | null | undefined,
): T | null {
  if (defaultSlug) {
    const declared = templates.find((template) => template.slug === defaultSlug);
    if (declared) return declared;
  }
  return templates[0] ?? null;
}
