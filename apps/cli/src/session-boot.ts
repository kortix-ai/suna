/**
 * The words the CLI prints while a session waits for `/start` to say `ready`.
 *
 * `POST /v1/projects/:id/sessions/:sid/start` names its stage, and while the
 * stage is `provisioning` its `boot.image` names the sandbox image step
 * (building the first image, copying it to a region, ...). A bare
 * "provisioning" for minutes reads as a hang, so every wait loop prints the
 * image step next to the stage. PRINT-FREE: callers write the lines.
 *
 * The types mirror `SessionStartResult`, `SessionStartBoot` and
 * `SessionStartImageStep` in `@kortix/api-contract`
 * (packages/api-contract/src/index.ts). The CLI does not depend on that
 * package, so only the fields the CLI reads are declared here.
 */

export type SessionStartStage = 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';

/** `SESSION_START_IMAGE_STATES`. A newer API may add one: it prints humanized. */
export type SessionStartImageState =
  | 'resolving'
  | 'serving_last_ready'
  | 'waiting_for_build'
  | 'building'
  | 'copying_to_region'
  | 'waiting_for_provider';

export interface SessionStartImageStep {
  state: SessionStartImageState;
  /** The image this step is about, when known (a provider snapshot name). */
  image: string | null;
  /** When this step began (ISO 8601). */
  since: string;
}

export interface SessionStartBoot {
  phase: string;
  since: string | null;
  actively_starting: boolean;
  /** The image step while `phase` is `provisioning`; absent from an older API. */
  image?: SessionStartImageStep | null;
}

/** The `/start` fields the CLI reads. JSON output passes the payload through whole. */
export interface SessionStartPayload {
  stage: SessionStartStage;
  agent_name?: string;
  retriable?: boolean;
  runtime_session_id?: string | null;
  reason?: string;
  /** The server clock of this answer: elapsed times count from it, not from the local clock. */
  observed_at?: string;
  boot?: SessionStartBoot;
}

const IMAGE_STEP_TEXT: Record<SessionStartImageState, { text: string; note?: string }> = {
  resolving: { text: 'choosing the image' },
  serving_last_ready: { text: 'starting from the last ready image while the new one builds' },
  waiting_for_build: { text: 'waiting for the first image for this workspace to finish building' },
  building: { text: 'building the first image for this workspace' },
  copying_to_region: { text: "copying the image to the session's region" },
  waiting_for_provider: { text: 'waiting for the provider to finish the image', note: 'retrying' },
};

/** `0:42`, `12:05`, `1:02:03`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * One image step as a phrase: `building the first image for this workspace (0:42)`.
 * The elapsed time counts from `step.since` to `nowMs`.
 */
export function describeImageStep(step: SessionStartImageStep, nowMs: number): string {
  const known = IMAGE_STEP_TEXT[step.state] as { text: string; note?: string } | undefined;
  const text = known?.text ?? String(step.state).replace(/_/g, ' ');
  const since = Date.parse(step.since);
  const extras = [known?.note, Number.isFinite(since) ? formatElapsed(nowMs - since) : undefined].filter(
    (part): part is string => Boolean(part),
  );
  return extras.length > 0 ? `${text} (${extras.join(', ')})` : text;
}

function nowFor(start: SessionStartPayload): number {
  const observed = start.observed_at ? Date.parse(start.observed_at) : Number.NaN;
  return Number.isFinite(observed) ? observed : Date.now();
}

/** `provisioning`, or `provisioning · building the first image for this workspace (0:42)`. */
export function describeStartProgress(start: SessionStartPayload): string {
  const image = start.boot?.image;
  return image ? `${start.stage} · ${describeImageStep(image, nowFor(start))}` : start.stage;
}

/**
 * A change filter for a wait loop: answers the line to print when the stage or
 * the image step changed since the last payload, and null otherwise. The
 * elapsed time alone never prints a new line.
 */
export function startProgressTracker(): (start: SessionStartPayload) => string | null {
  let previous: string | null = null;
  return (start) => {
    const key = `${start.stage}|${start.boot?.image?.state ?? ''}`;
    if (key === previous) return null;
    previous = key;
    return describeStartProgress(start);
  };
}

/**
 * Delay between `/start` polls: 4 s, the dashboard's cadence. 75 polls make the
 * ~5 min budget. `KORTIX_CLI_START_POLL_MS` overrides it (tests, slow links).
 */
export function startPollIntervalMs(): number {
  const env = process.env.KORTIX_CLI_START_POLL_MS?.trim();
  const raw = env ? Number(env) : Number.NaN;
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 4000;
}
