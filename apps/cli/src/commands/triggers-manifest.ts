import {
  TRIGGER_FILTER_OPERATORS,
  type TriggerFilter,
  formatDurationSeconds,
  parseDurationSeconds,
  parseTriggerFilter,
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

/** What `--type monitor` answers since the monitor box was removed. */
export const MONITOR_REMOVED =
  'monitor triggers were removed. Run the watcher in an App and fire with --type app, or poll with --type cron --every <dur> --target-app <slug>.';

/** Flags that are schedule/webhook wiring and are rejected on an event trigger. */
const EVENT_REJECTED_FLAGS: ReadonlyArray<[string, string]> = [
  ['--cron', 'cron'],
  ['--run-at', 'runAt'],
  ['--timezone', 'timezone'],
  ['--secret-env', 'secretEnv'],
];

/** Flags that only mean something on a `--type event` add. */
const EVENT_ONLY_FLAGS: ReadonlyArray<[string, string]> = [
  ['--connector', 'connector'],
  ['--account', 'account'],
  ['--default-account', 'defaultAccount'],
  ['--source', 'source'],
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
  source?: string;
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
  const source = (tf.source ?? '').trim();
  const config = tf.eventConfig ? (JSON.parse(tf.eventConfig) as Record<string, unknown>) : {};
  return { connector, ...(account ? { account } : {}), ...(source ? { source } : {}), event, config };
}

/** Event flags on a non-event trigger are a hard error — the platform would never read them. */
export function strayEventFlag(tf: Record<string, string | undefined>): string | null {
  const stray = EVENT_ONLY_FLAGS.find(([, key]) => tf[key] !== undefined);
  return stray ? `${stray[0]} is only valid on an event trigger (--type event).` : null;
}

/**
 * `--max-runs-per-hour` / `--max-runs-per-day` (KRTX-1721): a whole number of at
 * least 1, any trigger type. `allowClear` (\`set\`): `none` sends null, which
 * removes the cap.
 */
export function parseRunCapFlags(
  tf: Record<string, string | undefined>,
  allowClear: boolean,
): { caps: Record<string, number | string | null> } | { error: string } {
  const out: Record<string, number | string | null> = {};
  for (const [flag, key, field] of [
    ['--max-runs-per-hour', 'maxRunsPerHour', 'max_runs_per_hour'],
    ['--max-runs-per-day', 'maxRunsPerDay', 'max_runs_per_day'],
  ] as const) {
    const raw = tf[key]?.trim();
    if (raw === undefined) continue;
    if (allowClear && raw === 'none') {
      out[field] = null;
      continue;
    }
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
      return { error: `${flag} must be a whole number of at least 1${allowClear ? ', or none to remove it' : ''} (got "${raw}").` };
    }
    out[field] = value;
  }
  // --overlap (KRTX-1721): skip | allow; on `set`, default resets it.
  const overlap = tf.overlap?.trim();
  if (overlap !== undefined) {
    if (overlap === 'skip' || overlap === 'allow') out.overlap = overlap;
    else if (allowClear && overlap === 'default') out.overlap = null;
    else return { error: `--overlap must be skip or allow${allowClear ? ', or default to reset it' : ''} (got "${overlap}").` };
  }
  return { caps: out };
}

const LIST_FILTER_OPERATORS = ['not', 'in', 'prefix', 'not_prefix'];

/**
 * `--filter` flags → the payload filter (KRTX-1721). `path=value` is equality.
 * `path:op=value` picks an operator: `not`, `in`, `prefix` and `not_prefix`
 * take comma-separated values, `exists` takes true or false. Repeating a list
 * operator on one path adds to its list. A colon that names no operator stays
 * part of the path.
 */
export function parseFilterFlags(raw: readonly string[]): { filter: TriggerFilter | null } | { error: string } {
  const draft: Record<string, unknown> = {};
  for (const entry of raw) {
    const index = entry.indexOf('=');
    const left = index > 0 ? entry.slice(0, index).trim() : '';
    if (!left) return { error: `--filter must look like path=value or path:operator=value (got "${entry}")` };
    const value = entry.slice(index + 1);
    const colon = left.lastIndexOf(':');
    const operator = colon > 0 ? left.slice(colon + 1) : '';
    const isOperator = (TRIGGER_FILTER_OPERATORS as readonly string[]).includes(operator);
    const path = isOperator ? left.slice(0, colon).trim() : left;
    const existing = draft[path];
    const isList = LIST_FILTER_OPERATORS.includes(operator);
    const sameList = isList && typeof existing === 'object' && existing !== null && operator in existing;
    if (existing !== undefined && !sameList) {
      return { error: `--filter ${path} takes one condition; repeat only a list operator (${LIST_FILTER_OPERATORS.join(', ')})` };
    }
    if (isList) {
      const previous = sameList ? (existing as Record<string, string[]>)[operator] ?? [] : [];
      draft[path] = { [operator]: [...previous, ...value.split(',').map((item) => item.trim())] };
    } else if (isOperator) {
      if (value !== 'true' && value !== 'false') return { error: `--filter ${path}:exists takes true or false (got "${value}")` };
      draft[path] = { exists: value === 'true' };
    } else {
      draft[path] = value;
    }
  }
  const parsed = parseTriggerFilter(draft);
  return 'error' in parsed ? { error: `--filter: ${parsed.error}` } : parsed;
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

/**
 * `--app` belongs to a `--type app` trigger, which needs it and takes no
 * schedule or webhook wiring. Event flags are refused by their own check.
 */
export function appFlagProblem(type: string, tf: Record<string, string | undefined>): string | null {
  if (type !== 'app') return tf.app ? '--app is only valid on an app trigger (--type app).' : null;
  if (!tf.app) return 'app triggers need --app <slug>: the App whose events fire the trigger.';
  const stray = [['--cron', tf.cron], ['--run-at', tf.runAt], ['--timezone', tf.timezone], ['--secret-env', tf.secretEnv]].find(([, v]) => v !== undefined);
  return stray ? `${stray[0]} is not valid on an app trigger: the App decides when to fire.` : null;
}

/** `--every` is a cron trigger's alternative to `--cron`; `--target-path` needs `--target-app`. */
export function scheduleFlagProblem(type: string, tf: Record<string, string | undefined>): string | null {
  if (tf.every && type !== 'cron') return '--every is only valid on a cron trigger (--type cron).';
  if (tf.every && (tf.cron || tf.runAt)) return '--every, --cron and --run-at are exclusive: pass one.';
  if (tf.targetPath && !tf.targetApp) return '--target-path needs --target-app <slug>.';
  return null;
}

export async function triggersAddLocal(
  slug: string | undefined,
  tf: Record<string, string | undefined>,
  disabled: boolean,
  opts: CtxOpts = {},
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  const type = (tf.type ?? 'cron').toLowerCase();
  if (type === 'monitor') return fail(MONITOR_REMOVED);
  if (type !== 'cron' && type !== 'webhook' && type !== 'event' && type !== 'app') {
    return fail('--type must be cron, webhook, event, or app.');
  }
  if (!tf.prompt && !tf.targetApp) return fail('--prompt is required (or --target-app).');
  if (type !== 'event') {
    const stray = strayEventFlag(tf);
    if (stray) return fail(stray);
  }
  const appProblem = appFlagProblem(type, tf) ?? scheduleFlagProblem(type, tf);
  if (appProblem) return fail(appProblem);
  if (type === 'cron' && !tf.cron && !tf.every) {
    return fail('cron triggers need --cron "<6-field expr>" or --every <dur>.');
  }
  const parsedCaps = parseRunCapFlags(tf, false);
  if ('error' in parsedCaps) return fail(parsedCaps.error);
  const { caps } = parsedCaps;
  const every = tf.every ? parseFlagDuration(tf.every, '--every', 60) : null;
  if (every && 'error' in every) return fail(every.error);
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
    // The on/run shape, the same the API writes for a new trigger: what fires it, what it runs.
    const on: Record<string, unknown> =
      type === 'cron'
        ? tf.every
          ? { every: formatDurationSeconds(every!.seconds) }
          : { cron: tf.cron, ...(tf.timezone && tf.timezone !== 'UTC' ? { timezone: tf.timezone } : {}) }
        : type === 'app'
          ? { event: '*', app: tf.app }
          : type === 'event' && event
            ? {
                event: event.event, connector: event.connector,
                ...(event.account ? { account: event.account } : {}),
                ...(event.source ? { source: event.source } : {}),
                ...(Object.keys(event.config).length > 0 ? { config: event.config } : {}),
              }
            : { webhook: { secret: tf.secretEnv } };
    const run: Record<string, unknown> = tf.targetApp
      ? { app: tf.targetApp, ...(tf.targetPath ? { path: tf.targetPath } : {}) }
      : { ...(tf.agent ? { agent: tf.agent } : {}), prompt: tf.prompt };
    const fields: Record<string, unknown> = {
      slug,
      ...(tf.name ? { name: tf.name } : {}),
      on,
      run,
      ...(disabled ? { enabled: false } : {}),
      ...caps,
    };
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
