/**
 * The `on:` / `run:` trigger shape: a trigger is what happens (`on`) plus what
 * runs (`run`).
 *
 *   on:  { cron, timezone } | { every } | { at } | { webhook: { secret } }
 *        | { event, connector, account?, source?, config? } | { event, app }
 *   run: { agent?, prompt, session?, session_key?, session_id?, model? }
 *        | { app, path?, method?, payload? }
 *
 * `normalizeTriggerEntry` rewrites it into the flat fields (`type: cron`,
 * `cron`, `secret_env`, `target`, …) that every validator and parser reads, so
 * there is one set of rules for both shapes. A flat entry passes through
 * unchanged, and so does an `on`/`run` key this function does not recognize:
 * the validator then names it.
 */
type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `on:` keys → flat keys, per source. The first matching source wins. */
function normalizeOn(on: Row): { flat: Row; rest: Row; eventName?: string } | null {
  const { cron, timezone, every, at, webhook, event, connector, account, source, config, app, ...rest } = on;
  if (cron !== undefined) return { flat: { type: 'cron', cron, ...(timezone !== undefined ? { timezone } : {}) }, rest };
  if (every !== undefined) return { flat: { type: 'cron', every }, rest: { ...rest, ...(timezone !== undefined ? { timezone } : {}) } };
  if (at !== undefined) return { flat: { type: 'cron', run_at: at, ...(timezone !== undefined ? { timezone } : {}) }, rest };
  if (webhook !== undefined) {
    const secret = isRow(webhook) ? webhook.secret : undefined;
    return { flat: { type: 'webhook', ...(secret !== undefined ? { secret_env: secret } : {}) }, rest };
  }
  if (event !== undefined && app !== undefined) {
    return { flat: { type: 'app', app }, rest, ...(typeof event === 'string' && event !== '*' ? { eventName: event } : {}) };
  }
  if (event !== undefined) {
    return {
      flat: {
        type: 'event', event,
        ...(connector !== undefined ? { connector } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(config !== undefined ? { config } : {}),
      },
      rest,
    };
  }
  return null;
}

/** `run:` keys → flat keys: an agent run, or an App target. */
function normalizeRun(run: Row): Row {
  const { app, path, method, payload, session, ...agent } = run;
  return {
    ...agent,
    ...(session !== undefined ? { session_mode: session } : {}),
    ...(app !== undefined
      ? { target: { app, ...(path !== undefined ? { path } : {}), ...(method !== undefined ? { method } : {}), ...(payload !== undefined ? { payload } : {}) } }
      : {}),
  };
}

export function normalizeTriggerEntry<T>(entry: T): T | Row {
  // A legacy monitor's `run:` is a command string: only `on`, or a `run` table, is this shape.
  if (!isRow(entry) || (entry.on === undefined && !isRow(entry.run))) return entry;
  const { on, run, ...others } = entry;
  const out: Row = { ...others };
  if (isRow(on)) {
    const mapped = normalizeOn(on);
    if (mapped) {
      Object.assign(out, mapped.flat);
      if (Object.keys(mapped.rest).length > 0) out.on = mapped.rest;
      if (mapped.eventName) out.filter = { ...(isRow(entry.filter) ? entry.filter : {}), 'event.name': mapped.eventName };
    } else {
      out.on = on;
    }
  } else if (on !== undefined) {
    out.on = on;
  }
  if (isRow(run)) Object.assign(out, normalizeRun(run));
  else if (run !== undefined) out.run = run;
  return out;
}

/** The `triggers:` list with each entry normalized. Anything else is returned as is, for the validator to name. */
export function normalizeTriggerList(node: unknown): unknown {
  return Array.isArray(node) ? node.map((entry) => normalizeTriggerEntry(entry)) : node;
}
