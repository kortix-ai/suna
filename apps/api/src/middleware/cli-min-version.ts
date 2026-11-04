/**
 * Refuse a Kortix CLI older than `CLI_MIN_VERSION` with `426` and the update
 * command. An old CLI reads routes the API and the session box no longer
 * serve. The SDK it bundles throws `new Error(body.error)` on a non-2xx answer
 * (every version since 0.13), so `error` is the line the person reads, and
 * `kortix update` exists in every such version.
 *
 * Unset: no gate. Only `X-Kortix-Client-Version: cli/<major.minor.patch>` is
 * judged, with any `-pre`/`+build` suffix ignored. Another client, a `cli/dev`
 * build or no header pass.
 */
import type { MiddlewareHandler } from 'hono';
import { config } from '../config';

const CLI_VERSION = /^cli\/v?(\d+)\.(\d+)\.(\d+)/;
const VERSION = /^v?(\d+)\.?(\d+)?\.?(\d+)?/;

function parts(match: RegExpMatchArray | null): [number, number, number] | null {
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
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
  const minimum = config.CLI_MIN_VERSION;
  if (!minimum) return next();
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
