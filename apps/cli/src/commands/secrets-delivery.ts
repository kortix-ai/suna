/**
 * `kortix secrets delivery` + `kortix secrets call` — how a secret reaches
 * agent code: the strategy write (environment / enforced / none) and the
 * explicit brokered request through an enforced or legacy-broker secret.
 * Split out of secrets.ts: the delivery contract is one job, the value
 * set/share/grant surface another.
 */

import { readFileSync } from 'node:fs';
import {
  brokerProjectSecretRequest,
  setProjectSecretStrategy,
  type SecretBrokerRequest,
  type SecretEgressPolicy,
  type SecretInjectionSlot,
} from '@kortix/sdk';
import { withKortixScope } from '../api/sdk.ts';
import {
  fail,
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { C, status } from '../style.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

// Mirrors the backend's isValidIdentifier / web IDENTIFIER_REGEX: alphanumeric
// start, then letters/digits/_.- up to 128 chars total. Validated here only for
// a friendly error — the server is authoritative (incl. the key-conflict 409).
// Lives here and is imported by secrets.ts: the strategy module owns the
// identifier shape every secrets subcommand validates against.
export const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const SECRET_STRATEGIES = ['runtime', 'broker', 'egress', 'denied'] as const;
type SecretStrategy = (typeof SECRET_STRATEGIES)[number];

/**
 * What a user types → what the API stores.
 *
 * The exposure words are the model's; the stored `strategy` column
 * is unchanged, so both spellings resolve to the same four values and no
 * existing script or agent transcript breaks. `broker` has no exposure word of
 * its own: which exposure it means depends on its consumer, so it stays
 * reachable only under its stored name.
 */
const EXPOSURE_ALIASES: Readonly<Record<string, SecretStrategy>> = {
  environment: 'runtime',
  enforced: 'egress',
  'egress-enforced': 'egress',
  none: 'denied',
};

/** The stored strategy for an EXPOSURE or a legacy strategy name; null if neither. */
export function parseExposure(input: string | undefined): SecretStrategy | null {
  if (input === undefined) return null;
  const normalized = input.trim().toLowerCase();
  if (SECRET_STRATEGIES.includes(normalized as SecretStrategy)) return normalized as SecretStrategy;
  return EXPOSURE_ALIASES[normalized] ?? null;
}

const BROKER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type BrokerMethod = (typeof BROKER_METHODS)[number];

/**
 * True when the error is the `secrets_egress` feature-flag gate — the 403
 * `{ error, code: 'feature_disabled', feature: 'secrets_egress' }` the API
 * returns when enforced exposure is entered with the flag off. Read the body
 * structurally (CLI `ApiError` keeps it in `.body`; an SDK `ApiError` in
 * `.details`/`.data` and lifts `code`), so a good hint rides alongside the
 * server's own verbatim message.
 */
function isSecretsEgressDisabled(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const carrier = err as { code?: unknown; body?: unknown; details?: unknown; data?: unknown };
  const body = [carrier.body, carrier.details, carrier.data].find(
    (candidate): candidate is Record<string, unknown> =>
      !!candidate && typeof candidate === 'object' && !Array.isArray(candidate),
  );
  const code = typeof carrier.code === 'string' ? carrier.code : body?.code;
  return code === 'feature_disabled' && body?.feature === 'secrets_egress';
}

/** The one-line confirmation, in the exposure the user just chose. */
function deliveryLabel(strategy: SecretStrategy, consumer?: string): string {
  if (strategy === 'runtime') return 'Exposed in the sandbox environment';
  if (strategy === 'egress') return 'Enforced at the network';
  if (strategy === 'broker') {
    return consumer === 'http_broker'
      ? 'Enforced at the network — `kortix secrets call` only'
      : `Spent by Kortix (${(consumer ?? 'service').replace(/_/g, ' ')}), never in the sandbox`;
  }
  return 'Stored but disabled';
}
/** The HTTP-policy flags of a delivery write, taken out of argv by the shared grammar. */
interface DeliveryFlags {
  allowedHosts: string[];
  allowedMethods: string[];
  allowedPath?: string;
  injectHeader?: string;
  injectQuery?: string;
  injectJson?: string;
  template?: string;
  handlePrefix?: string;
  consumerFlag?: string;
}

/** Take the delivery flags out of `options`. Throws a flag error the caller prints. */
function parseDeliveryFlags(options: string[]): DeliveryFlags {
  return {
    allowedHosts: takeFlagValues(options, ['--allow-host']),
    allowedMethods: takeFlagValues(options, ['--allow-method']).map((method) =>
      method.toUpperCase(),
    ),
    allowedPath: takeFlagValue(options, ['--allow-path']),
    injectHeader: takeFlagValue(options, ['--inject-header']),
    injectQuery: takeFlagValue(options, ['--inject-query']),
    injectJson: takeFlagValue(options, ['--inject-json']),
    template: takeFlagValue(options, ['--template']),
    handlePrefix: takeFlagValue(options, ['--handle-prefix']),
    consumerFlag: takeFlagValue(options, ['--consumer']),
  };
}

/** Either a finished policy, or the one validation error to print. */
type PolicyResult = SecretEgressPolicy | { error: string };

const hasHttpPolicyOptions = (f: DeliveryFlags): boolean =>
  f.allowedHosts.length > 0 ||
  f.allowedMethods.length > 0 ||
  f.allowedPath !== undefined ||
  f.injectHeader !== undefined ||
  f.injectQuery !== undefined ||
  f.injectJson !== undefined ||
  f.template !== undefined ||
  f.handlePrefix !== undefined;

/** The legacy http_broker row: host rules + exactly one injection slot. */
function buildBrokerPolicy(f: DeliveryFlags): PolicyResult {
  if (f.allowedHosts.length === 0) return { error: 'A legacy http-broker row requires --allow-host.' };
  const injectionValues = [f.injectHeader, f.injectQuery, f.injectJson].filter(
    (value): value is string => value !== undefined,
  );
  if (injectionValues.length !== 1) {
    return { error: 'A legacy http-broker row requires exactly one injection flag.' };
  }
  if (f.template !== undefined && f.injectHeader === undefined) {
    return { error: '--template requires --inject-header.' };
  }
  if (f.allowedMethods.some((method) => !BROKER_METHODS.includes(method as BrokerMethod))) {
    return { error: 'Invalid --allow-method value.' };
  }
  const inject: SecretInjectionSlot = f.injectHeader
    ? { kind: 'header', name: f.injectHeader, ...(f.template ? { template: f.template } : {}) }
    : f.injectQuery
      ? { kind: 'query', name: f.injectQuery }
      : { kind: 'json_body_field', path: f.injectJson! };
  return {
    backend: 'kortix_fetch',
    rules: f.allowedHosts.map((host) => ({
      host,
      ...(f.allowedMethods.length > 0 ? { methods: f.allowedMethods } : {}),
      ...(f.allowedPath ? { path: f.allowedPath } : {}),
    })),
    inject,
    on_no_match: 'deny',
    tls: 'terminate',
  };
}

const EXACT_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The enforced (egress) row: the host list IS the policy. */
function buildEgressPolicy(f: DeliveryFlags): PolicyResult {
  const normalizedHosts = f.allowedHosts.map((host) => host.trim().toLowerCase());
  // The whole policy of an enforced secret is its host list: the value is substituted
  // for the handle wherever the agent's own client put it, so there is no
  // slot for the CLI to name and no method or path for it to promise.
  const legacyOnly = [
    f.allowedMethods.length > 0 ? '--allow-method' : null,
    f.allowedPath !== undefined ? '--allow-path' : null,
    f.injectQuery !== undefined ? '--inject-query' : null,
    f.injectJson !== undefined ? '--inject-json' : null,
    f.handlePrefix !== undefined ? '--handle-prefix' : null,
  ].filter((flag): flag is string => flag !== null);
  if (legacyOnly.length > 0) {
    return {
      error: `${legacyOnly.join(', ')} configure${legacyOnly.length === 1 ? 's' : ''} a legacy http-broker row, not an enforced secret.`,
    };
  }
  if (normalizedHosts.length === 0) {
    return { error: 'Enforced exposure requires --allow-host — the host list is the policy.' };
  }
  if (normalizedHosts.some((host) => !EXACT_HOST.test(host))) {
    return { error: 'Enforced exposure requires exact hosts — no wildcards, no paths, no scheme.' };
  }
  if (f.template !== undefined && f.injectHeader === undefined) {
    return { error: '--template requires --inject-header.' };
  }
  if (f.template !== undefined && !f.template.includes('{{secret}}')) {
    return { error: '--template must contain {{secret}}.' };
  }
  return {
    rules: [...new Set(normalizedHosts)].map((host) => ({ host })),
    // Absent by default: a substitution row. `--inject-header` is kept, and
    // kept working, because scripts and stored rows use it — it writes the
    // legacy injection row the server still serves unchanged.
    ...(f.injectHeader
      ? {
          inject: {
            kind: 'header' as const,
            name: f.injectHeader,
            ...(f.template ? { template: f.template } : {}),
          },
        }
      : {}),
    on_no_match: 'deny',
    tls: 'terminate',
  };
}

export async function secretsDelivery(args: string[], opts: CtxOpts, json = false): Promise<number> {
  const [identifier, strategyRaw] = args;
  const options = args.slice(2);
  if (!identifier || !IDENTIFIER_RE.test(identifier)) {
    return fail('Usage: kortix secrets delivery IDENTIFIER environment|enforced|none');
  }
  const strategy = parseExposure(strategyRaw);
  if (strategy === null) {
    return fail(
        'Exposure must be environment, enforced, or none (stored aliases: runtime, egress, broker, denied).',
      );
  }

  let f: DeliveryFlags;
  try {
    f = parseDeliveryFlags(options);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (options.length > 0) {
    return fail(`Unknown delivery option: ${options[0]}`);
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const normalizedConsumer = f.consumerFlag?.replace(/-/g, '_') ?? 'http_broker';
  // Preserve the old `automation` flag as an input alias. Send only the canonical value.
  const consumer = normalizedConsumer === 'automation' ? 'connector' : normalizedConsumer;
  if (strategy === 'broker' && !['llm_gateway', 'connector', 'http_broker'].includes(consumer)) {
    return fail('--consumer must be llm-gateway, connector, or http-broker.');
  }
  if (strategy !== 'broker' && f.consumerFlag !== undefined) {
    return fail(
        '--consumer names the Kortix service that spends a none-exposure secret. Pass it with the `broker` alias.',
      );
  }
  if (strategy !== 'broker' && strategy !== 'egress' && hasHttpPolicyOptions(f)) {
    return fail(
        'Host and injection flags describe a policy, which only an enforced secret has.',
      );
  }
  if (strategy === 'broker' && consumer !== 'http_broker' && hasHttpPolicyOptions(f)) {
    return fail(`HTTP policy flags cannot be used with the ${consumer.replace(/_/g, '-')} consumer.`);
  }

  let policy: SecretEgressPolicy | undefined;
  if (strategy === 'broker' && consumer === 'http_broker') {
    const built = buildBrokerPolicy(f);
    if ('error' in built) {
      return fail(built.error);
    }
    policy = built;
  } else if (strategy === 'egress') {
    const built = buildEgressPolicy(f);
    if ('error' in built) {
      return fail(built.error);
    }
    policy = built;
  }

  try {
    const result = await withKortixScope(ctx.auth, () =>
      setProjectSecretStrategy(ctx.projectId, identifier, strategy, {
        ...(strategy === 'broker'
          ? { consumer: consumer as 'llm_gateway' | 'connector' | 'http_broker' }
          : {}),
        ...(policy ? { egress_policy: policy } : {}),
        ...(f.handlePrefix ? { handle_prefix: f.handlePrefix } : {}),
      }),
    );
    if (json) {
      emitJson(result);
      return 0;
    }
    process.stdout.write(
      `${status.ok(
        `${identifier}: ${deliveryLabel(strategy, strategy === 'broker' ? consumer : undefined)}`,
      )}\n`,
    );
    if (strategy === 'runtime') {
      process.stdout.write(
        `  ${C.dim}The real value is an env var in the sandbox. Agent code, and anything it runs, can read it.${C.reset}\n`,
      );
    } else if (strategy === 'egress') {
      // The mechanism is now the same on every provider, so this says what it
      // does rather than promising an outcome and hiding the how: the env var
      // is a handle, the swap happens on the approved hosts, an echo comes back
      // redacted, and `call` is the door for a request that never reaches the
      // relay. An agent that knows the last line does not go asking a human for
      // the raw value.
      process.stdout.write(
        `  ${C.dim}The env var holds a handle. Kortix substitutes the real value outside the sandbox, only on those hosts, and rewrites any echo of it to [REDACTED].${C.reset}\n` +
          `  ${C.dim}Agent code sends the handle with its ordinary HTTP client. For a request that cannot be intercepted, run \`kortix secrets call ${identifier} <https-url>\`.${C.reset}\n`,
      );
      if (result.network_boundary_available === false) {
        process.stdout.write(
          `  ${status.warn(
            'This Kortix server reports no enforcement path — requests would leave carrying the handle, not the value.',
          )}\n`,
        );
      }
    } else if (result.requires_rotation) {
      process.stdout.write(
        `  ${C.dim}Rotate the value because an earlier sandbox may retain it.${C.reset}\n`,
      );
    }
    return 0;
  } catch (err) {
    // Entering enforced exposure with the `secrets_egress` flag off returns the
    // gate 403. `surfaceApiError` prints the server's verbatim message
    // ("Network-Enforced Secrets is not enabled for this project. Enable it in
    // Settings → Feature flags."); add the actionable alternative so the user
    // does not have to enable the flag to make progress.
    if (strategy === 'egress' && isSecretsEgressDisabled(err)) {
      const code = surfaceApiError(err);
      process.stderr.write(
        `  ${C.dim}Or use \`environment\` exposure to load the value into the sandbox: kortix secrets delivery ${identifier} environment${C.reset}\n`,
      );
      return code;
    }
    return surfaceApiError(err);
  }
}

export async function secretsCall(args: string[], opts: CtxOpts, json = false): Promise<number> {
  const [identifier, rawUrl] = args;
  const options = args.slice(2);
  if (!identifier || !IDENTIFIER_RE.test(identifier) || !rawUrl) {
    return fail('Usage: kortix secrets call IDENTIFIER URL [options]');
  }

  let methodRaw: string | undefined;
  let headerValues: string[];
  let inlineBody: string | undefined;
  let bodyFile: string | undefined;
  try {
    methodRaw = takeFlagValue(options, ['--method']);
    headerValues = takeFlagValues(options, ['--header']);
    inlineBody = takeFlagValue(options, ['--data']);
    bodyFile = takeFlagValue(options, ['--data-file']);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (options.length > 0) {
    return fail(`Unknown call option: ${options[0]}`);
  }
  if (inlineBody !== undefined && bodyFile !== undefined) {
    return fail('Pass only one request body: --data or --data-file.');
  }
  const method = (methodRaw ?? 'GET').toUpperCase();
  if (!BROKER_METHODS.includes(method as BrokerMethod)) {
    return fail(`Invalid HTTP method: ${method}`);
  }
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    return fail('`kortix secrets call` needs a valid https:// URL.');
  }

  const headers: Record<string, string> = {};
  for (const rawHeader of headerValues) {
    const separator = rawHeader.includes(':') ? rawHeader.indexOf(':') : rawHeader.indexOf('=');
    if (separator <= 0) {
      return fail(`Malformed header: ${rawHeader}`);
    }
    const name = rawHeader.slice(0, separator).trim().toLowerCase();
    const value = rawHeader.slice(separator + 1).trim();
    if (!name) {
      return fail(`Malformed header: ${rawHeader}`);
    }
    headers[name] = value;
  }

  let body: string | undefined = inlineBody;
  if (bodyFile !== undefined) {
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch (err) {
      return fail(`Cannot read request body: ${(err as Error).message}`);
    }
  }
  const request: SecretBrokerRequest = {
    url: rawUrl,
    method: method as BrokerMethod,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body_base64: Buffer.from(body).toString('base64') } : {}),
  };

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  try {
    const result = await withKortixScope(ctx.auth, () =>
      brokerProjectSecretRequest(ctx.projectId, identifier, request),
    );
    if (json) {
      emitJson(result);
      return 0;
    }
    const contentType = result.headers['content-type'] ?? '';
    const isText =
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('javascript');
    const responseBody = isText
      ? Buffer.from(result.body_base64, 'base64').toString('utf8')
      : result.body_base64;
    process.stdout.write(
      `\n  ${C.bold}Upstream status: ${result.status}${C.reset}\n` +
        `  ${C.dim}${isText ? 'Body' : 'Body (base64)'}${C.reset}\n${responseBody}\n\n`,
    );
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}
