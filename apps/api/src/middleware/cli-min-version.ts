/**
 * Refuse a Kortix CLI older than `CLI_MIN_VERSION` with `426` and the update
 * command. An old CLI reads routes the API and the session box no longer
 * serve. The SDK it bundles throws `new Error(body.error)` on a non-2xx answer
 * (every version since 0.13), so `error` is the line the person reads, and
 * `kortix update` exists in every such version.
 *
 * The minimum is never below `BUILT_IN_CLI_MIN_VERSION`: a CLI before it reads
 * OpenCode routes this API and the session box no longer serve. A higher
 * `CLI_MIN_VERSION` raises it; a lower one is ignored. Only
 * `X-Kortix-Client-Version: cli/<major.minor.patch>` is judged, with any
 * `-pre`/`+build` suffix ignored. Another client, a `cli/dev` build or no
 * header pass.
 */
import type { MiddlewareHandler } from 'hono';
import { config } from '../config';

/** The first CLI that reads only the session log and the Kortix runtime routes. */
export const BUILT_IN_CLI_MIN_VERSION = '0.14.13';

const CLI_VERSION = /^cli\/v?(\d+)\.(\d+)\.(\d+)/;
const VERSION = /^v?(\d+)\.?(\d+)?\.?(\d+)?/;

function parts(match: RegExpMatchArray | null): [number, number, number] | null {
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** The higher of the built-in minimum and `configured`. */
export function effectiveCliMinimum(configured: string): string {
  const floor = parts(BUILT_IN_CLI_MIN_VERSION.match(VERSION))!;
  const raised = parts(configured.trim().match(VERSION));
  if (!raised) return BUILT_IN_CLI_MIN_VERSION;
  for (let i = 0; i < 3; i++) {
    if (raised[i] !== floor[i]) return raised[i] > floor[i] ? configured.trim().replace(/^v/, '') : BUILT_IN_CLI_MIN_VERSION;
  }
  return BUILT_IN_CLI_MIN_VERSION;
}

/** The CLI's own version when it is below `minimum`, else null. */
export function outdatedCliVersion(header: string | undefined, minimum: string): string | null {
  const cli = parts(header?.trim().match(CLI_VERSION) ?? null);
  const floor = parts(minimum.trim().match(VERSION));
  if (!cli || !floor) return null;
  for (let i = 0; i < 3; i++) {
    if (cli[i] !== floor[i]) return cli[i] < floor[i] ? cli.join('.') : null;
  }
  return null;
}

export const rejectOutdatedCli: MiddlewareHandler = async (c, next) => {
  const minimum = effectiveCliMinimum(config.CLI_MIN_VERSION);
  const outdated = outdatedCliVersion(c.req.header('x-kortix-client-version'), minimum);
  if (!outdated) return next();
  return c.json(
    {
      error: `This Kortix CLI (${outdated}) is older than this server supports (minimum ${minimum}). Update it: kortix update`,
      code: 'cli_too_old',
      minimum_version: minimum,
    },
    426,
  );
};
