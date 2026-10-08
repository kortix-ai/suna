import {
  MONITOR_MIN_EXPECT_EVENT_WITHIN_SECONDS,
  MONITOR_MIN_INTERVAL_SECONDS,
  MONITOR_MODES,
  MONITOR_RUN_MAX_LENGTH,
  formatDurationSeconds,
  parseDurationSeconds,
} from '@kortix/manifest-schema';
import { type CtxOpts, fail, missing } from '../command-helpers.ts';
import {
  appendArrayBlock,
  arrayEntryExists,
  removeArrayBlock,
  setScalarInArrayBlock,
} from '../manifest-edit.ts';
import { C, status } from '../style.ts';
import { checkEventConfig, quietCatalogContext } from './triggers-events.ts';

// add/rm/toggle a [[triggers]] block in the LOCAL kortix.yaml (source of
// truth). `kortix ship` applies it; the live cloud path lives in
// triggers-live.ts.

/** Flags that only mean something on a `--type monitor` add. */
const MONITOR_ONLY_FLAGS: ReadonlyArray<[string, string]> = [
  ['--run', 'run'],
  ['--mode', 'mode'],
  ['--interval', 'interval'],
  ['--expect-event-within', 'expectEventWithin'],
];

/** Flags that are cron/webhook wiring and are rejected on a monitor. */
const MONITOR_REJECTED_FLAGS: ReadonlyArray<[string, string]> = [
  ['--cron', 'cron'],
  ['--timezone', 'timezone'],
  ['--secret-env', 'secretEnv'],
];

/** Flags that are schedule/monitor/webhook wiring and are rejected on an event trigger. */
const EVENT_REJECTED_FLAGS: ReadonlyArray<[string, string]> = [
  ['--cron', 'cron'],
  ['--run-at', 'runAt'],
  ['--timezone', 'timezone'],
  ['--secret-env', 'secretEnv'],
  ['--run', 'run'],
  ['--mode', 'mode'],
  ['--interval', 'interval'],
  ['--expect-event-within', 'expectEventWithin'],
];

/** Flags that only mean something on a `--type event` add. */
const EVENT_ONLY_FLAGS: ReadonlyArray<[string, string]> = [
  ['--connector', 'connector'],
  ['--account', 'account'],
  ['--default-account', 'defaultAccount'],
  ['--event', 'event'],
  ['--config / --config-json', 'eventConfig'],
];

/**
 * Collapse repeated `--config key=value` pairs and `--config-json '{...}'` into
 * one JSON string on `tf.eventConfig` (values from `--config` stay strings;
 * `--config-json` carries typed values; a `--config` key overrides the JSON key).
 */
export function collectEventConfig(
  pairs: readonly string[],
  json: string | undefined,
): string | undefined | { error: string } {
  if (pairs.length === 0 && json === undefined) return undefined;
  let config: Record<string, unknown> = {};
  if (json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { error: '--config-json must be a JSON object, e.g. \'{"repo":"acme/app"}\'.' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: '--config-json must be a JSON object, e.g. \'{"repo":"acme/app"}\'.' };
    }
    config = parsed as Record<string, unknown>;
  }
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index <= 0) return { error: `--config must look like key=value (got "${pair}").` };
    config[pair.slice(0, index).trim()] = pair.slice(index + 1);
  }
  return JSON.stringify(config);
}

interface EventFields {
  connector: string;
  account?: string;
  event: string;
  config: Record<string, unknown>;
}

/** Validate the `--type event` flags; mirrors `validateEventTrigger` in `@kortix/manifest-schema`. */
export function parseEventFlags(
  tf: Record<string, string | undefined>,
): EventFields | { error: string } {
  const rejected = EVENT_REJECTED_FLAGS.find(([, key]) => tf[key] !== undefined);
  if (rejected) {
    return {
      error: `${rejected[0]} is not valid on an event trigger — events are driven by the connected app.`,
    };
  }
  const connector = (tf.connector ?? '').trim();
  if (!connector) return { error: 'event triggers need --connector <slug>.' };
  const event = (tf.event ?? '').trim();
  if (!event) {
    return {
      error: 'event triggers need --event <TYPE> (list them: `kortix triggers events --connector <slug>`).',
    };
  }
  if (tf.defaultAccount !== undefined) {
    return { error: '--default-account only applies to `kortix triggers set`. On add, omit --account.' };
  }
  const account = (tf.account ?? '').trim();
  const config = tf.eventConfig ? (JSON.parse(tf.eventConfig) as Record<string, unknown>) : {};
  return { connector, ...(account ? { account } : {}), event, config };
}

/** Event flags on a non-event trigger are a hard error — the platform would never read them. */
export function strayEventFlag(tf: Record<string, string | undefined>): string | null {
  const stray = EVENT_ONLY_FLAGS.find(([, key]) => tf[key] !== undefined);
  return stray ? `${stray[0]} is only valid on an event trigger (--type event).` : null;
}

interface MonitorFields {
  run: string;
  mode: string;
  intervalSeconds: number | null;
  expectEventWithinSeconds: number | null;
}

/**
 * Validate the `--type monitor` flags locally, rule for rule with the API's
 * `parseMonitorFields` and `@kortix/manifest-schema`'s `validateMonitorTrigger`.
 * The CLI writes the manifest, so it must reject exactly what `kortix ship`
 * would reject — a manifest that only fails server-side is a worse error than
 * no manifest at all.
 */
export function parseMonitorFlags(
  tf: Record<string, string | undefined>,
): MonitorFields | { error: string } {
  const rejected = MONITOR_REJECTED_FLAGS.find(([, key]) => tf[key] !== undefined);
  if (rejected) {
    return {
      error: `${rejected[0]} is not valid on a monitor trigger — monitors are driven by their \`run\` process.`,
    };
  }

  const run = (tf.run ?? '').trim();
  if (!run) {
    return { error: 'monitor triggers need --run "<command>" (repo-relative).' };
  }
  if (run.length > MONITOR_RUN_MAX_LENGTH) {
    return { error: `--run must be at most ${MONITOR_RUN_MAX_LENGTH} characters.` };
  }
  if (/[\r\n]/.test(run)) {
    return { error: '--run must be a single command line — no newlines.' };
  }

  const mode = (tf.mode ?? '').trim().toLowerCase();
  if (!(MONITOR_MODES as readonly string[]).includes(mode)) {
    return {
      error: `--mode must be ${MONITOR_MODES.join(' or ')} (got "${mode || 'unset'}").`,
    };
  }

  let intervalSeconds: number | null = null;
  if (mode === 'poll') {
    const parsed = parseFlagDuration(tf.interval, '--interval', MONITOR_MIN_INTERVAL_SECONDS);
    if ('error' in parsed) return parsed;
    intervalSeconds = parsed.seconds;
  } else if (tf.interval !== undefined) {
    return {
      error: '--interval is only valid on a `--mode poll` monitor — a stream runs continuously.',
    };
  }

  let expectEventWithinSeconds: number | null = null;
  if (tf.expectEventWithin !== undefined) {
    const parsed = parseFlagDuration(
      tf.expectEventWithin,
      '--expect-event-within',
      MONITOR_MIN_EXPECT_EVENT_WITHIN_SECONDS,
    );
    if ('error' in parsed) return parsed;
    expectEventWithinSeconds = parsed.seconds;
  }

  return { run, mode, intervalSeconds, expectEventWithinSeconds };
}

/** Parse a duration flag ("30s", "5m", "24h", "7d") against its platform floor. */
function parseFlagDuration(
  raw: string | undefined,
  flag: string,
  floorSeconds: number,
): { seconds: number } | { error: string } {
  const floor = formatDurationSeconds(floorSeconds);
  const value = (raw ?? '').trim();
  if (!value) {
    return {
      error: `${flag} is required here — a duration like "${floor}", "5m", or "24h" (minimum ${floor}).`,
    };
  }
  const seconds = parseDurationSeconds(value);
  if (seconds === null) {
    return {
      error: `${flag} must be a positive integer plus s/m/h/d, e.g. "${floor}" (got "${value}").`,
    };
  }
  if (seconds < floorSeconds) {
    return { error: `${flag} must be at least ${floor} (got "${value}").` };
  }
  return { seconds };
}

export async function triggersAddLocal(
  slug: string | undefined,
  tf: Record<string, string | undefined>,
  disabled: boolean,
  opts: CtxOpts = {},
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  const type = (tf.type ?? 'cron').toLowerCase();
  if (type !== 'cron' && type !== 'webhook' && type !== 'monitor' && type !== 'event') {
    return fail('--type must be cron, webhook, monitor, or event.');
  }
  if (!tf.prompt) return fail('--prompt is required.');
  if (type !== 'event') {
    const stray = strayEventFlag(tf);
    if (stray) return fail(stray);
  }
  if (type === 'cron' && !tf.cron) {
    return fail('cron triggers need --cron "<6-field expr>".');
  }
  // Monitor flags on a cron/webhook trigger are a hard error, not a silent
  // drop — the platform would never read them.
  if (type !== 'monitor' && type !== 'event') {
    const stray = MONITOR_ONLY_FLAGS.find(([, value]) => tf[value] !== undefined);
    if (stray) {
      return fail(`${stray[0]} is only valid on a monitor trigger (--type monitor).`);
    }
  }
  let monitor: MonitorFields | null = null;
  if (type === 'monitor') {
    const parsed = parseMonitorFlags(tf);
    if ('error' in parsed) return fail(parsed.error);
    monitor = parsed;
  }
  let event: EventFields | null = null;
  if (type === 'event') {
    const parsed = parseEventFlags(tf);
    if ('error' in parsed) return fail(parsed.error);
    event = parsed;
    // Online: coerce + validate against the catalog so `kortix ship` does not
    // reject what this wrote. Offline (not logged in): write it as given.
    const ctx = await quietCatalogContext(opts);
    const checked = await checkEventConfig(ctx, parsed.connector, parsed.event, parsed.config);
    if ('error' in checked) return fail(checked.error);
    event = { ...parsed, config: checked.config };
    if (!ctx) {
      process.stdout.write(
        `${C.dim}Config not checked against the event catalog (not logged in).${C.reset}\n`,
      );
    }
  }
  try {
    if (arrayEntryExists('triggers', 'slug', slug)) {
      process.stderr.write(
        `${status.err(`A [[triggers]] "${slug}" already exists in kortix.yaml.`)}\n`,
      );
      return 1;
    }
    const fields: Record<string, unknown> = { slug };
    if (tf.name) fields.name = tf.name;
    fields.type = type;
    if (tf.agent) fields.agent = tf.agent;
    fields.enabled = !disabled;
    if (type === 'cron') {
      fields.cron = tf.cron;
      fields.timezone = tf.timezone ?? 'UTC';
    } else if (type === 'monitor' && monitor) {
      fields.run = monitor.run;
      fields.mode = monitor.mode;
      // Durations are re-emitted canonically ("60s" → "1m"), the same
      // normalization the API's write path applies.
      if (monitor.intervalSeconds !== null) {
        fields.interval = formatDurationSeconds(monitor.intervalSeconds);
      }
      if (monitor.expectEventWithinSeconds !== null) {
        fields.expect_event_within = formatDurationSeconds(monitor.expectEventWithinSeconds);
      }
    } else if (type === 'event' && event) {
      fields.connector = event.connector;
      if (event.account) fields.account = event.account;
      fields.event = event.event;
      if (Object.keys(event.config).length > 0) fields.config = event.config;
    } else if (tf.secretEnv) {
      fields.secret_env = tf.secretEnv;
    }
    fields.prompt = tf.prompt;
    appendArrayBlock('triggers', fields);
    process.stdout.write(
      `${status.ok(`Added [[triggers]] ${C.bold}${slug}${C.reset} (${type}) to kortix.yaml`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

export function triggersRmLocal(slug: string | undefined): number {
  if (!slug) return missing('a trigger slug');
  try {
    if (!removeArrayBlock('triggers', 'slug', slug)) {
      process.stderr.write(`${status.err(`No [[triggers]] "${slug}" in kortix.yaml.`)}\n`);
      return 1;
    }
    process.stdout.write(
      `${status.ok(`Removed [[triggers]] ${C.bold}${slug}${C.reset}`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

// enabled is config — toggle it in the LOCAL kortix.yaml `[[triggers]]` block
// (the source of truth), preserving the block's comments. `kortix ship` applies.
export function triggersToggle(slug: string | undefined, enabled: boolean): number {
  if (!slug) return missing('a trigger slug');
  try {
    if (!arrayEntryExists('triggers', 'slug', slug)) {
      process.stderr.write(`${status.err(`No [[triggers]] "${slug}" in kortix.yaml.`)}\n`);
      return 1;
    }
    setScalarInArrayBlock('triggers', 'slug', slug, 'enabled', enabled);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
  process.stdout.write(
    `${status.ok(`${enabled ? 'Enabled' : 'Disabled'} ${C.bold}${slug}${C.reset}`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
  );
  return 0;
}
