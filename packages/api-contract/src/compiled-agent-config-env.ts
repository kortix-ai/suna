/**
 * How the compiled agent config crosses an `execve`.
 *
 * apps/api hands a session's compiled agent config to its sandbox as an env
 * var, and kortixd (which bundles this file) keeps it in its own process env.
 * Linux refuses an `execve` whose environment holds one `NAME=VALUE\0` string
 * longer than MAX_ARG_STRLEN, 128 KiB. On Platinum, the guest's PID 1 exports
 * every env var and execs the entrypoint, so an oversized value means the box
 * never boots. Measured on Platinum prod over 7 days to 2026-10-14:
 *   - all 25 creates whose `KORTIX_COMPILED_AGENT_CONFIG=…\0` was 131,734 to
 *     269,979 bytes failed, each after about 4 minutes of retries;
 *   - all 1,587 creates under the limit booted. The largest was 115,720 bytes.
 * Platinum now refuses such a create with `400 env_var_too_large`
 * (kortix-ai/platinum#1569). That makes it fail fast, but it still fails.
 *
 * The carrier picks one of two forms, never both:
 *   - The value fits in one env string: `KORTIX_COMPILED_AGENT_CONFIG=<json>`,
 *     byte for byte what it always was. A daemon built before this file reads
 *     it unchanged.
 *   - The value does not fit: `KORTIX_COMPILED_AGENT_CONFIG_GZ_PARTS=<n>` and
 *     `KORTIX_COMPILED_AGENT_CONFIG_GZ_0` … `_GZ_<n-1>`. Together these are the
 *     base64 of the gzipped JSON, cut into slices that each fit. The raw name
 *     is absent. A daemon built before this file sees no compiled config at all.
 *
 * kortixd reads through `readCompiledAgentConfigEnv` and writes through
 * `writeCompiledAgentConfigEnv`. OpenCode, git, every PTY and every other child
 * inherits the daemon's env, so the daemon must never hold the oversized raw
 * form either. That includes values that arrive later, from a config release
 * or a `/kortix/env` push.
 *
 * Node built-ins only: kortixd is a standalone binary.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

/** The raw JSON form. The only form a daemon built before this file understands. */
export const COMPILED_AGENT_CONFIG_ENV = 'KORTIX_COMPILED_AGENT_CONFIG';
/** The gzip form's marker: how many `_GZ_<i>` parts to join. */
export const COMPILED_AGENT_CONFIG_GZ_PARTS_ENV = 'KORTIX_COMPILED_AGENT_CONFIG_GZ_PARTS';
/** Every gzip-form name starts with this, the marker included. */
const GZ_PREFIX = 'KORTIX_COMPILED_AGENT_CONFIG_GZ_';

/** The name of gzip part `index`. */
export function compiledAgentConfigGzPartEnv(index: number): string {
  return `${GZ_PREFIX}${index}`;
}

/**
 * kortixd lists this in `/kortix/health` capabilities when it reads the gzip
 * form and keeps its own env within the limit. apps/api pushes an oversized
 * config to a running daemon only when the daemon lists it.
 */
export const COMPILED_AGENT_CONFIG_GZ_CAPABILITY = 'agent-config.env-gz.v1';

/**
 * Linux MAX_ARG_STRLEN (32 pages of 4 KiB). It is the longest `NAME=VALUE\0`
 * that `execve` accepts, counting the trailing NUL. Platinum enforces the same
 * bound at create.
 */
export const MAX_ENV_STRING_BYTES = 131_072;

/**
 * Base64 characters per gzip part. Every part name is under 40 bytes, so each
 * part's env string sits about 32 KiB under the limit.
 */
const GZ_PART_CHARS = 96 * 1024;

/**
 * The most parts the carrier writes or reads. 16 parts is 1.5 MiB of base64,
 * which is most of the 2 MiB total environment `execve` allows on a default
 * 8 MiB stack. A config past this cannot reach a sandbox through env in any form.
 */
export const MAX_COMPILED_AGENT_CONFIG_GZ_PARTS = 16;

/** The config cannot reach a sandbox through its environment, even compressed. */
export class CompiledAgentConfigTooLargeError extends Error {
  constructor(
    readonly configBytes: number,
    readonly encodedBytes: number,
  ) {
    super(
      `compiled agent config is ${configBytes} bytes (${encodedBytes} gzip+base64); ` +
        `the sandbox environment carries at most ${MAX_COMPILED_AGENT_CONFIG_GZ_PARTS * GZ_PART_CHARS}`,
    );
    this.name = 'CompiledAgentConfigTooLargeError';
  }
}

/** The gzip form is present but cannot be read back. */
export class CompiledAgentConfigEnvError extends Error {
  constructor(message: string) {
    super(`${COMPILED_AGENT_CONFIG_GZ_PARTS_ENV}: ${message}`);
    this.name = 'CompiledAgentConfigEnvError';
  }
}

/** Bytes `execve` counts for `NAME=VALUE`, including the trailing NUL. UTF-8, not UTF-16. */
export function envStringBytes(name: string, value: string): number {
  return Buffer.byteLength(name, 'utf8') + 1 + Buffer.byteLength(value, 'utf8') + 1;
}

/** Whether `NAME=VALUE\0` is short enough for `execve`. */
export function fitsInEnvString(name: string, value: string): boolean {
  return envStringBytes(name, value) <= MAX_ENV_STRING_BYTES;
}

/**
 * The env vars that carry `config`. The raw form when it fits, otherwise the
 * gzip form. Every returned `NAME=VALUE\0` fits in one env string. Throws
 * `CompiledAgentConfigTooLargeError` when even the gzip form exceeds
 * `MAX_COMPILED_AGENT_CONFIG_GZ_PARTS`.
 */
export function encodeCompiledAgentConfigEnv(config: string): Record<string, string> {
  if (fitsInEnvString(COMPILED_AGENT_CONFIG_ENV, config)) return { [COMPILED_AGENT_CONFIG_ENV]: config };
  const encoded = gzipSync(Buffer.from(config, 'utf8'), { level: 9 }).toString('base64');
  const parts = Math.ceil(encoded.length / GZ_PART_CHARS);
  if (parts > MAX_COMPILED_AGENT_CONFIG_GZ_PARTS) {
    throw new CompiledAgentConfigTooLargeError(Buffer.byteLength(config, 'utf8'), encoded.length);
  }
  const env: Record<string, string> = { [COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]: String(parts) };
  for (let index = 0; index < parts; index++) {
    env[compiledAgentConfigGzPartEnv(index)] = encoded.slice(index * GZ_PART_CHARS, (index + 1) * GZ_PART_CHARS);
  }
  return env;
}

/** The last gzip form read and its JSON. kortixd reads it on every spawn and tool call. */
let lastDecoded: { encoded: string; config: string } | null = null;

/**
 * The compiled agent config `env` carries, in either form.
 *
 * A non-empty raw value wins, so a daemon that reads this behaves exactly like
 * one that reads the raw name directly. With no raw value and no gzip marker,
 * the result is the raw value as it stands: `undefined`, or an empty string,
 * which every reader already treats as no config. Throws
 * `CompiledAgentConfigEnvError` when the marker is present and the parts are
 * missing or corrupt. A damaged governance is never silently treated as none.
 */
export function readCompiledAgentConfigEnv(env: Record<string, string | undefined>): string | undefined {
  const raw = env[COMPILED_AGENT_CONFIG_ENV];
  if (raw) return raw;
  const declared = env[COMPILED_AGENT_CONFIG_GZ_PARTS_ENV];
  if (declared === undefined || declared === '') return raw;
  const parts = Number(declared);
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_COMPILED_AGENT_CONFIG_GZ_PARTS) {
    throw new CompiledAgentConfigEnvError(`declares ${JSON.stringify(declared.slice(0, 16))} parts`);
  }
  let encoded = '';
  for (let index = 0; index < parts; index++) {
    const part = env[compiledAgentConfigGzPartEnv(index)];
    if (!part) throw new CompiledAgentConfigEnvError(`part ${index} of ${parts} is missing`);
    encoded += part;
  }
  if (lastDecoded?.encoded === encoded) return lastDecoded.config;
  let config: string;
  try {
    config = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
  } catch (err) {
    throw new CompiledAgentConfigEnvError(`does not gunzip (${err instanceof Error ? err.message : String(err)})`);
  }
  lastDecoded = { encoded, config };
  return config;
}

/**
 * Point `env` at `config`, or clear it with `null`. Every name of both forms is
 * removed first, so no stale part or stale raw value outlives a change of form.
 * Encodes before touching `env`: a `CompiledAgentConfigTooLargeError` leaves it
 * as it was.
 */
export function writeCompiledAgentConfigEnv(env: Record<string, string | undefined>, config: string | null): void {
  const next = config === null ? {} : encodeCompiledAgentConfigEnv(config);
  for (const name of Object.keys(env)) {
    if (name === COMPILED_AGENT_CONFIG_ENV || name.startsWith(GZ_PREFIX)) delete env[name];
  }
  Object.assign(env, next);
}
