/**
 * Input rules of the create-schedule sheet (COR-155). Pure: no React.
 *
 * Cron: the server validates with croner (`apps/api/src/projects/
 * trigger-schedule.ts`, `validateTriggerCron`), which accepts 5 or 6 fields.
 * The API and SDK document the stored form as a 6-field expression with
 * seconds first, and every preset (`CRON_PRESETS`) is 6-field. So a user
 * types the usual 5-field cron (`0 9 * * *`) and `normalizeCron` sends
 * `0 0 9 * * *`: the stored value matches the presets and `describeCron`
 * names it. A 6-field expression passes through unchanged.
 *
 * Time zone: a new schedule defaults to the device's IANA zone, not UTC.
 */

import { TIMEZONES } from './triggers-format';

export type CronResult = { ok: true; cron: string } | { ok: false; error: string };

/** croner's nicknames. */
const NICKNAMES = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly']);

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: string[];
  /** `?` and croner's L / W / # forms are allowed here. */
  dayField?: boolean;
}

/** The 6 stored fields, seconds first. */
const FIELDS: FieldSpec[] = [
  { label: 'Second', min: 0, max: 59 },
  { label: 'Minute', min: 0, max: 59 },
  { label: 'Hour', min: 0, max: 23 },
  { label: 'Day of month', min: 1, max: 31, dayField: true },
  { label: 'Month', min: 1, max: 12, names: MONTHS },
  { label: 'Weekday', min: 0, max: 7, names: DAYS, dayField: true },
];

export const CRON_FORMAT_HINT = '5 fields: minute hour day month weekday';

function valueOf(token: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  if (spec.names) {
    const i = spec.names.indexOf(token.toUpperCase());
    if (i !== -1) return spec.label === 'Month' ? i + 1 : i;
  }
  return null;
}

/** `null` when the field is valid, else the message. */
function checkField(field: string, spec: FieldSpec): string | null {
  const range = `${spec.label} must be ${spec.min}–${spec.max}`;
  for (const part of field.split(',')) {
    if (!part) return `${spec.label} has an empty list item`;
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) return `${spec.label} "${part}" is not valid`;
    const [, base, step] = m;
    if (step !== undefined && Number(step) < 1) return `${spec.label} step must be 1 or more`;
    if (base === '*') continue;
    if (base === '?' && spec.dayField) continue;
    // croner's last-day / nearest-weekday / nth-weekday forms: the server
    // checks them.
    if (spec.dayField && /[LW#]/i.test(base) && /^[0-9A-Z#-]+$/i.test(base)) continue;
    const bounds = base.split('-');
    if (bounds.length > 2) return `${spec.label} "${part}" is not valid`;
    const values = bounds.map((b) => valueOf(b, spec));
    if (values.some((v) => v === null)) return `${spec.label} "${part}" is not valid`;
    if (values.some((v) => v! < spec.min || v! > spec.max)) return `${range} (got "${part}")`;
    if (values.length === 2 && values[0]! > values[1]!) return `${spec.label} range "${part}" runs backwards`;
  }
  return null;
}

/**
 * Validate a cron the user typed and normalize it to the stored 6-field form.
 * Accepts 5 fields (minute hour day month weekday), 6 fields (seconds first),
 * or a croner nickname (`@daily`).
 */
export function normalizeCron(input: string): CronResult {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, error: 'Enter a schedule' };
  if (text.startsWith('@')) {
    const nick = text.toLowerCase();
    return NICKNAMES.has(nick) ? { ok: true, cron: nick } : { ok: false, error: `Unknown schedule "${text}"` };
  }
  const parts = text.split(' ');
  if (parts.length !== 5 && parts.length !== 6) {
    return { ok: false, error: `Use ${CRON_FORMAT_HINT} (got ${parts.length})` };
  }
  const six = parts.length === 5 ? ['0', ...parts] : parts;
  for (let i = 0; i < 6; i++) {
    const error = checkField(six[i], FIELDS[i]);
    if (error) return { ok: false, error };
  }
  return { ok: true, cron: six.join(' ') };
}

/**
 * The 5-field form of a stored cron, for the input field: `0 0 9 * * *` →
 * `0 9 * * *`. A 6-field cron with a non-zero seconds field, a nickname, or
 * anything else comes back unchanged.
 */
export function toFiveFieldCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  return parts.length === 6 && parts[0] === '0' ? parts.slice(1).join(' ') : cron.trim();
}

/**
 * The device's IANA time zone, else `UTC`. `resolve` exists for tests; the
 * default reads `Intl` (Hermes ships it on iOS and Android).
 */
export function deviceTimezone(
  resolve: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  try {
    const tz = resolve();
    return typeof tz === 'string' && tz.trim() ? tz.trim() : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The picker's zones: the device zone first when the fixed list lacks it. */
export function timezoneOptions(device: string, list: readonly string[] = TIMEZONES): string[] {
  return list.includes(device) ? [...list] : [device, ...list];
}
