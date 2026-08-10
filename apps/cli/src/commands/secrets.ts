import { readFileSync } from 'node:fs';
import {
  brokerWorkspaceSecretRequest,
  setWorkspaceSecretStrategy,
  type SecretBrokerRequest,
  type SecretEgressPolicy,
  type SecretInjectionSlot,
} from '@kortix/sdk';
import type { WorkspaceSecret, WorkspaceSecretsResponse } from '../api/types.ts';
import { withKortixScope } from '../api/sdk.ts';
import {
  emitJson,
  resolveWorkspaceContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { loadLocalManifest } from '../manifest.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix secrets <subcommand> [options]

Manage encrypted secrets on the linked Kortix workspace. A delivery policy
controls whether each value reaches a sandbox or stays on Kortix services.

A secret has an IDENTIFIER (the unique handle an agent's
\`secrets\` grant references), a KEY (the env var injected into the sandbox),
and a value. Runtime delivery uses KEY as an environment variable. Leave the
identifier blank and it defaults to the key. Set it explicitly to keep a
second credential profile under the same key.

Subcommands:
  ls                                List secrets (by identifier, → key when it
                                    differs) + manifest [env] spec. --json.
                                    JSON mirrors API fields: name, configured,
                                    available, effective_source, strategy,
                                    consumer, and delivery_status. Legacy key
                                    and has_value aliases remain available.
  set KEY=VALUE [KEY=VALUE …]       Upsert one or more secrets. Identifier
                                    defaults to KEY.
                                    Use \`KEY=-\` to read VALUE from stdin.
    --identifier <id>               Store under an explicit identifier (a second
    --id <id>                       value under the same KEY). One KEY=VALUE only.
  request NAME [NAME …]             Mint a link (valid 7 days) for a human to
                                    ENTER the value(s) — never pasted into
                                    chat. Surface the URL (web: fill-in
                                    modal, Slack: tappable link). Reuse a live
                                    link across runs — do not re-mint/re-post
                                    while one is unexpired.
                                    --scope runtime|connector  --expires <min>
  sync                              Force a re-push of all workspace secrets to
                                    this session's sandbox. Use after setting
                                    a secret via the intake link or after a
                                    secret was updated mid-session.
  delivery IDENTIFIER STRATEGY      Set runtime, broker, egress, or denied.
    --consumer <service>             Broker consumer: llm-gateway, connector,
                                    automation, or http-broker.
    --allow-host <host>              Approved host. Repeat for more hosts.
    --allow-method <method>          Broker only. Repeat as needed.
    --allow-path <path>              Broker only. Exact path or trailing /*.
    --inject-header <name>           Inject into one managed header.
    --inject-query <name>            Broker only. Inject into a query parameter.
    --inject-json <path>             Broker only. Inject into a JSON body field.
    --template <value>               Header template containing {{secret}}.
    --handle-prefix <prefix>         Optional vendor-shaped sandbox handle.
  call IDENTIFIER URL               Send one policy-bound HTTPS request.
    --method <method>                Default: GET.
    --header <name:value>            Request header. Repeat as needed.
    --data <value>                   Inline request body.
    --data-file <path>               Read the request body from a file.
  unset IDENTIFIER [IDENTIFIER …]   Remove one or more secrets (by identifier).

Which agents may use a secret is governed by that agent's \`secrets\` grant in
kortix.yaml (by identifier), not a per-secret setting here.

Global options:
  --workspace <id>     Operate on this workspace id (default: linked or
                     \$KORTIX_WORKSPACE_ID).
  -h, --help         Show this help.
`;

export async function runSecrets(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  const json = takeFlagBool(rest, ['--json']);
  let workspaceFlag: string | undefined;
  let hostFlag: string | undefined;
  try {
    workspaceFlag = takeFlagValue(rest, ['--workspace', '--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts = { workspaceArg: workspaceFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return secretsLs(ctxOpts, json);
    case 'set':
      return secretsSet(rest, ctxOpts);
    case 'request':
    case 'req':
      return secretsRequest(rest, ctxOpts, json);
    case 'sync':
      return secretsSync(ctxOpts, json);
    case 'delivery':
    case 'strategy':
      return secretsDelivery(rest, ctxOpts, json);
    case 'call':
      return secretsCall(rest, ctxOpts, json);
    case 'unset':
    case 'rm':
    case 'remove':
      return secretsUnset(rest, ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

type CtxOpts = { workspaceArg?: string; hostArg?: string };

// Mirrors the backend's isValidIdentifier / web IDENTIFIER_REGEX: alphanumeric
// start, then letters/digits/_.- up to 128 chars total. Validated here only for
// a friendly error — the server is authoritative (incl. the key-conflict 409).
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A displayed secret slot: keyed by identifier, with the env key it injects. */
type SecretRow = {
  identifier: string;
  key: string;
  spec: 'required' | 'optional' | 'undeclared';
  configured: boolean;
  available: boolean;
  effectiveSource: 'mine' | 'shared' | 'none';
  strategy: 'runtime' | 'egress' | 'broker' | 'denied';
  consumer: WorkspaceSecret['consumer'];
  deliveryStatus: 'available' | 'unavailable' | 'disabled';
  requiresRotation: boolean;
};

async function secretsLs(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;

  let resp: WorkspaceSecretsResponse;
  try {
    resp = await ctx.client.get<WorkspaceSecretsResponse>(`/workspaces/${ctx.workspaceId}/secrets`);
  } catch (err) {
    return surfaceApiError(err);
  }

  // The server's required/optional come from its mirror of kortix.yaml, which
  // is eventually-consistent — right after `kortix ship` it can still be empty
  // ("missing"), which would mislabel freshly-declared secrets as "undeclared".
  // The local kortix.yaml is authoritative + instant, so fall back to it
  // whenever the cloud mirror isn't loaded yet.
  const local = (() => {
    try {
      return loadLocalManifest();
    } catch {
      return null;
    }
  })();
  const usingLocal = resp.manifest_status !== 'loaded' && local !== null;
  const localEnv = usingLocal && local ? local.env : null;
  const required = localEnv?.required ?? resp.required;
  const optional = localEnv?.optional ?? resp.optional;

  // The manifest [env] contract is by env KEY (uppercased names the runtime
  // needs); a secret is addressed by IDENTIFIER and injects one KEY. So we match
  // required/optional against the key, but list rows by identifier — surfacing
  // two identifiers under one key as two distinct rows (the web does the same).
  const requiredSet = new Set(required);
  const optionalSet = new Set(optional);
  const itemState = (secret: WorkspaceSecret) => {
    const configured = secret.configured ?? true;
    const effectiveSource = secret.effective_source ?? (configured ? 'shared' : 'none');
    return {
      configured,
      effectiveSource,
      available: effectiveSource !== 'none',
      strategy: secret.strategy ?? 'runtime',
      consumer: secret.consumer ?? (secret.strategy === 'denied' ? null : 'sandbox'),
      deliveryStatus:
        secret.delivery_status ?? (secret.strategy === 'denied' ? 'disabled' : 'available'),
      requiresRotation: secret.requires_rotation ?? false,
    } as const;
  };
  const availableKeys = new Set(
    resp.items.filter((secret) => itemState(secret).available).map((secret) => secret.name),
  );
  const requiredMissing = required.filter((key) => !availableKeys.has(key));

  const declaredOrder: string[] = [];
  const seenDeclared = new Set<string>();
  for (const k of [...required, ...optional]) {
    if (!seenDeclared.has(k)) {
      seenDeclared.add(k);
      declaredOrder.push(k);
    }
  }

  const allRows: SecretRow[] = [];
  for (const key of declaredOrder) {
    const spec = requiredSet.has(key) ? 'required' : 'optional';
    const backing = resp.items.filter((s) => s.name === key);
    if (backing.length === 0) {
      allRows.push({
        identifier: key,
        key,
        spec,
        configured: false,
        available: false,
        effectiveSource: 'none',
        strategy: 'runtime',
        consumer: 'sandbox',
        deliveryStatus: 'available',
        requiresRotation: false,
      });
    } else {
      for (const s of backing) {
        const state = itemState(s);
        allRows.push({ identifier: s.identifier, key: s.name, spec, ...state });
      }
    }
  }
  for (const s of resp.items) {
    if (!seenDeclared.has(s.name)) {
      const state = itemState(s);
      allRows.push({ identifier: s.identifier, key: s.name, spec: 'undeclared', ...state });
    }
  }

  if (json) {
    emitJson({
      secrets: allRows.map((r) => ({
        identifier: r.identifier,
        name: r.key,
        configured: r.configured,
        available: r.available,
        effective_source: r.effectiveSource,
        strategy: r.strategy,
        consumer: r.consumer,
        delivery_status: r.deliveryStatus,
        requires_rotation: r.requiresRotation,
        // Backward-compatible aliases for older CLI JSON consumers.
        key: r.key,
        has_value: r.available,
        source: r.spec,
      })),
      manifest: {
        status: usingLocal ? 'local' : resp.manifest_status,
        required,
        optional,
      },
    });
    return 0;
  }

  process.stdout.write('\n');
  if (usingLocal) {
    process.stdout.write(
      `  ${C.dim}Manifest: cloud mirror ${resp.manifest_status} — showing local kortix.yaml [env] spec.${C.reset}\n\n`,
    );
  } else if (resp.manifest_status !== 'loaded') {
    process.stdout.write(
      `  ${C.dim}Manifest: ${resp.manifest_status}${
        resp.manifest_error ? ` — ${resp.manifest_error}` : ''
      }${C.reset}\n\n`,
    );
  }

  if (resp.items.length === 0 && required.length === 0 && optional.length === 0) {
    process.stdout.write(`  ${C.dim}No secrets set, no [env] spec in kortix.yaml.${C.reset}\n\n`);
    return 0;
  }

  const nameW = Math.max(...allRows.map((r) => r.identifier.length), 4);
  process.stdout.write(
    `  ${C.dim}${pad('IDENTIFIER', nameW)}   STATUS    DELIVERY          SPEC${C.reset}\n`,
  );
  for (const r of allRows) {
    const marker = r.available ? `${C.green}● ${C.reset}` : `${C.yellow}○ ${C.reset}`;
    const statusTxt = r.available
      ? r.effectiveSource === 'mine'
        ? 'personal'
        : 'set     '
      : 'missing ';
    const specColor =
      r.spec === 'required' && !r.available ? C.yellow : r.spec === 'undeclared' ? C.faded : C.dim;
    // Show the injected env key only when it differs from the identifier —
    // the second-value-under-same-key case (mirrors the web's "→ key").
    const keyHint = r.key !== r.identifier ? ` ${C.dim}→ ${r.key}${C.reset}` : '';
    const delivery =
      r.strategy === 'runtime'
        ? 'sandbox'
        : r.strategy === 'denied'
          ? 'disabled'
          : r.strategy === 'broker'
            ? (r.consumer ?? 'Kortix broker')
            : 'approved hosts';
    const rotation = r.requiresRotation ? ' · rotate' : '';
    const deliveryText = `${delivery}${rotation}`;
    process.stdout.write(
      `${marker}${pad(r.identifier, nameW)}   ${statusTxt}  ${pad(deliveryText, 16)}  ${specColor}${r.spec}${C.reset}${keyHint}\n`,
    );
  }

  process.stdout.write('\n');
  if (requiredMissing.length > 0) {
    process.stdout.write(
      `  ${status.warn(
        `${requiredMissing.length} required secret${
          requiredMissing.length === 1 ? '' : 's'
        } missing — sessions will start but may misbehave.`,
      )}\n`,
    );
  }
  const availableCount = allRows.filter((row) => row.available).length;
  process.stdout.write(
    `  ${C.dim}${availableCount} available · ${required.length} required · ${optional.length} optional${C.reset}\n\n`,
  );
  return 0;
}

const SECRET_STRATEGIES = ['runtime', 'broker', 'egress', 'denied'] as const;
type SecretStrategy = (typeof SECRET_STRATEGIES)[number];
const BROKER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type BrokerMethod = (typeof BROKER_METHODS)[number];

function takeFlagValues(args: string[], names: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length;) {
    if (!names.includes(args[index]!)) {
      index += 1;
      continue;
    }
    const flag = args[index]!;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    values.push(value);
    args.splice(index, 2);
  }
  return values;
}

function deliveryLabel(strategy: SecretStrategy): string {
  if (strategy === 'runtime') return 'Readable in sandbox';
  if (strategy === 'broker') return 'Used through Kortix';
  if (strategy === 'egress') return 'Sent only to approved hosts';
  return 'Stored but disabled';
}

async function secretsDelivery(args: string[], opts: CtxOpts, json = false): Promise<number> {
  const [identifier, strategyRaw] = args;
  const options = args.slice(2);
  if (!identifier || !IDENTIFIER_RE.test(identifier)) {
    process.stderr.write(
      `${status.err('Usage: kortix secrets delivery IDENTIFIER runtime|broker|egress|denied')}\n`,
    );
    return 2;
  }
  if (!SECRET_STRATEGIES.includes(strategyRaw as SecretStrategy)) {
    process.stderr.write(`${status.err('Delivery must be runtime, broker, egress, or denied.')}\n`);
    return 2;
  }

  let allowedHosts: string[];
  let allowedMethods: string[];
  let allowedPath: string | undefined;
  let injectHeader: string | undefined;
  let injectQuery: string | undefined;
  let injectJson: string | undefined;
  let template: string | undefined;
  let handlePrefix: string | undefined;
  let consumerFlag: string | undefined;
  try {
    allowedHosts = takeFlagValues(options, ['--allow-host']);
    allowedMethods = takeFlagValues(options, ['--allow-method']).map((method) =>
      method.toUpperCase(),
    );
    allowedPath = takeFlagValue(options, ['--allow-path']);
    injectHeader = takeFlagValue(options, ['--inject-header']);
    injectQuery = takeFlagValue(options, ['--inject-query']);
    injectJson = takeFlagValue(options, ['--inject-json']);
    template = takeFlagValue(options, ['--template']);
    handlePrefix = takeFlagValue(options, ['--handle-prefix']);
    consumerFlag = takeFlagValue(options, ['--consumer']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if (options.length > 0) {
    process.stderr.write(`${status.err(`Unknown delivery option: ${options[0]}`)}\n`);
    return 2;
  }

  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;
  const strategy = strategyRaw as SecretStrategy;
  const normalizedConsumer = consumerFlag?.replace(/-/g, '_') ?? 'http_broker';
  // Preserve the old `automation` flag as an input alias. Send only the canonical value.
  const consumer = normalizedConsumer === 'automation' ? 'connector' : normalizedConsumer;
  if (
    strategy === 'broker' &&
    !['llm_gateway', 'connector', 'http_broker'].includes(consumer)
  ) {
    process.stderr.write(
      `${status.err('--consumer must be llm-gateway, connector, or http-broker.')}\n`,
    );
    return 2;
  }
  if (strategy !== 'broker' && consumerFlag !== undefined) {
    process.stderr.write(`${status.err('--consumer is only valid for broker delivery.')}\n`);
    return 2;
  }
  const hasHttpPolicyOptions =
    allowedHosts.length > 0 ||
    allowedMethods.length > 0 ||
    allowedPath !== undefined ||
    injectHeader !== undefined ||
    injectQuery !== undefined ||
    injectJson !== undefined ||
    template !== undefined ||
    handlePrefix !== undefined;
  if (strategy !== 'broker' && strategy !== 'egress' && hasHttpPolicyOptions) {
    process.stderr.write(
      `${status.err('HTTP policy flags are only valid for broker or egress delivery.')}\n`,
    );
    return 2;
  }

  let policy: SecretEgressPolicy | undefined;
  if (strategy === 'broker' && consumer !== 'http_broker' && hasHttpPolicyOptions) {
    process.stderr.write(
      `${status.err(`HTTP policy flags cannot be used with the ${consumer.replace(/_/g, '-')} consumer.`)}\n`,
    );
    return 2;
  }
  if (strategy === 'broker' && consumer === 'http_broker') {
    if (allowedHosts.length === 0) {
      process.stderr.write(`${status.err('Broker delivery requires --allow-host.')}\n`);
      return 2;
    }
    const injectionValues = [injectHeader, injectQuery, injectJson].filter(
      (value): value is string => value !== undefined,
    );
    if (injectionValues.length !== 1) {
      process.stderr.write(
        `${status.err('Broker delivery requires exactly one injection flag.')}\n`,
      );
      return 2;
    }
    if (template !== undefined && injectHeader === undefined) {
      process.stderr.write(`${status.err('--template requires --inject-header.')}\n`);
      return 2;
    }
    if (allowedMethods.some((method) => !BROKER_METHODS.includes(method as BrokerMethod))) {
      process.stderr.write(`${status.err('Invalid --allow-method value.')}\n`);
      return 2;
    }
    const inject: SecretInjectionSlot = injectHeader
      ? { kind: 'header', name: injectHeader, ...(template ? { template } : {}) }
      : injectQuery
        ? { kind: 'query', name: injectQuery }
        : { kind: 'json_body_field', path: injectJson! };
    policy = {
      backend: 'kortix_fetch',
      rules: allowedHosts.map((host) => ({
        host,
        ...(allowedMethods.length > 0 ? { methods: allowedMethods } : {}),
        ...(allowedPath ? { path: allowedPath } : {}),
      })),
      inject,
      on_no_match: 'deny',
      tls: 'terminate',
    };
  }
  if (strategy === 'egress') {
    const exactHost =
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    const normalizedHosts = allowedHosts.map((host) => host.trim().toLowerCase());
    const unsupported =
      allowedMethods.length > 0 ||
      allowedPath !== undefined ||
      injectQuery !== undefined ||
      injectJson !== undefined ||
      handlePrefix !== undefined;
    if (
      normalizedHosts.length === 0 ||
      normalizedHosts.some((host) => !exactHost.test(host)) ||
      !injectHeader ||
      unsupported
    ) {
      process.stderr.write(
        `${status.err('Network delivery supports exact hosts and header injection only.')}\n`,
      );
      return 2;
    }
    if (template !== undefined && !template.includes('{{secret}}')) {
      process.stderr.write(`${status.err('--template must contain {{secret}}.')}\n`);
      return 2;
    }
    policy = {
      rules: [...new Set(normalizedHosts)].map((host) => ({ host })),
      inject: {
        kind: 'header',
        name: injectHeader,
        ...(template ? { template } : {}),
      },
      on_no_match: 'deny',
      tls: 'terminate',
    };
  }

  try {
    const result = await withKortixScope(ctx.auth, () =>
      setWorkspaceSecretStrategy(ctx.workspaceId, identifier, strategy, {
        ...(strategy === 'broker'
          ? { consumer: consumer as 'llm_gateway' | 'connector' | 'http_broker' }
          : {}),
        ...(policy ? { egress_policy: policy } : {}),
        ...(handlePrefix ? { handle_prefix: handlePrefix } : {}),
      }),
    );
    if (json) {
      emitJson(result);
      return 0;
    }
    process.stdout.write(`${status.ok(`${identifier}: ${deliveryLabel(strategy)}`)}\n`);
    if (strategy === 'runtime') {
      process.stdout.write(
        `  ${C.dim}The value is available to agent code and commands inside the sandbox.${C.reset}\n`,
      );
    } else if (strategy === 'egress') {
      process.stdout.write(
        `  ${C.dim}Platinum injects the value outside the sandbox for approved hosts only.${C.reset}\n`,
      );
    } else if (result.requires_rotation) {
      process.stdout.write(
        `  ${C.dim}Rotate the value because an earlier sandbox may retain it.${C.reset}\n`,
      );
    }
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

async function secretsCall(args: string[], opts: CtxOpts, json = false): Promise<number> {
  const [identifier, rawUrl] = args;
  const options = args.slice(2);
  if (!identifier || !IDENTIFIER_RE.test(identifier) || !rawUrl) {
    process.stderr.write(`${status.err('Usage: kortix secrets call IDENTIFIER URL [options]')}\n`);
    return 2;
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
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if (options.length > 0) {
    process.stderr.write(`${status.err(`Unknown call option: ${options[0]}`)}\n`);
    return 2;
  }
  if (inlineBody !== undefined && bodyFile !== undefined) {
    process.stderr.write(`${status.err('Pass only one request body: --data or --data-file.')}\n`);
    return 2;
  }
  const method = (methodRaw ?? 'GET').toUpperCase();
  if (!BROKER_METHODS.includes(method as BrokerMethod)) {
    process.stderr.write(`${status.err(`Invalid HTTP method: ${method}`)}\n`);
    return 2;
  }
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    process.stderr.write(`${status.err('Broker URL must be a valid HTTPS URL.')}\n`);
    return 2;
  }

  const headers: Record<string, string> = {};
  for (const rawHeader of headerValues) {
    const separator = rawHeader.includes(':') ? rawHeader.indexOf(':') : rawHeader.indexOf('=');
    if (separator <= 0) {
      process.stderr.write(`${status.err(`Malformed header: ${rawHeader}`)}\n`);
      return 2;
    }
    const name = rawHeader.slice(0, separator).trim().toLowerCase();
    const value = rawHeader.slice(separator + 1).trim();
    if (!name) {
      process.stderr.write(`${status.err(`Malformed header: ${rawHeader}`)}\n`);
      return 2;
    }
    headers[name] = value;
  }

  let body: string | undefined = inlineBody;
  if (bodyFile !== undefined) {
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch (err) {
      process.stderr.write(
        `${status.err(`Cannot read request body: ${(err as Error).message}`)}\n`,
      );
      return 2;
    }
  }
  const request: SecretBrokerRequest = {
    url: rawUrl,
    method: method as BrokerMethod,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body_base64: Buffer.from(body).toString('base64') } : {}),
  };

  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;
  try {
    const result = await withKortixScope(ctx.auth, () =>
      brokerWorkspaceSecretRequest(ctx.workspaceId, identifier, request),
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

async function secretsSet(args: string[], opts: CtxOpts): Promise<number> {
  // An explicit identifier (--identifier / --id) keeps a second value under the
  // same KEY. It addresses exactly one secret, so it pairs with a single
  // KEY=VALUE; omit it and the identifier defaults to the KEY (the common case,
  // where any number of pairs is fine).
  let identifier: string | undefined;
  try {
    identifier = takeFlagValue(args, ['--identifier', '--id']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if (identifier !== undefined) {
    identifier = identifier.trim();
    if (!IDENTIFIER_RE.test(identifier)) {
      process.stderr.write(
        `${status.err(
          `invalid identifier "${identifier}" — start alphanumeric, then letters/digits/._- (max 128 chars)`,
        )}\n`,
      );
      return 2;
    }
  }

  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;
  if (args.length === 0) {
    process.stderr.write(`${status.err('Pass at least one KEY=VALUE pair.')}\n`);
    return 2;
  }

  const pairs: { key: string; value: string }[] = [];
  let stdinUsed = false;
  for (const raw of args) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      process.stderr.write(`${status.err(`malformed pair "${raw}" — expected KEY=VALUE`)}\n`);
      return 2;
    }
    // The backend uppercases + validates the key; do it here too so the printed
    // identifier/key match what's stored (parity with the web KEY_NAME field).
    const key = raw.slice(0, eq).trim().toUpperCase();
    let value = raw.slice(eq + 1);
    if (value === '-') {
      if (stdinUsed) {
        process.stderr.write(`${status.err('Only one KEY=- per invocation.')}\n`);
        return 2;
      }
      stdinUsed = true;
      value = readFileSync(0, 'utf8').replace(/\n$/, '');
    }
    pairs.push({ key, value });
  }

  if (identifier !== undefined && pairs.length !== 1) {
    process.stderr.write(
      `${status.err('--identifier addresses one secret — pass exactly one KEY=VALUE pair.')}\n`,
    );
    return 2;
  }

  let okCount = 0;
  for (const p of pairs) {
    const shownId = identifier ?? p.key;
    const label =
      shownId !== p.key
        ? `${C.bold}${shownId}${C.reset} ${C.dim}→ ${p.key}${C.reset}`
        : `${C.bold}${p.key}${C.reset}`;
    try {
      await ctx.client.post<WorkspaceSecret>(`/workspaces/${ctx.workspaceId}/secrets`, {
        name: p.key,
        ...(identifier !== undefined ? { identifier } : {}),
        value: p.value,
      });
      okCount += 1;
      process.stdout.write(`${status.ok(label)}\n`);
    } catch (err) {
      surfaceApiError(err);
      process.stderr.write(`  ${C.dim}└─ for ${shownId}${C.reset}\n`);
    }
  }
  process.stdout.write(`\n  ${C.dim}${okCount}/${pairs.length} set${C.reset}\n\n`);
  return okCount === pairs.length ? 0 : 1;
}

async function secretsRequest(rest: string[], opts: CtxOpts, json = false): Promise<number> {
  let scope: string | undefined;
  let expires: string | undefined;
  try {
    scope = takeFlagValue(rest, ['--scope']);
    expires = takeFlagValue(rest, ['--expires']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const names = rest.map((n) => n.trim().toUpperCase()).filter(Boolean);
  if (names.length === 0) {
    process.stderr.write(`${status.err('Pass at least one secret NAME to request.')}\n`);
    return 2;
  }

  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;

  let resp: { url: string; names: string[]; scope: string; expires_at: string };
  try {
    resp = await ctx.client.post(`/workspaces/${ctx.workspaceId}/secret-requests`, {
      names,
      ...(scope ? { scope } : {}),
      ...(expires ? { expires_in_minutes: Number(expires) } : {}),
    });
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  process.stdout.write(
    `\n  ${C.bold}Hand this link to whoever has the value${C.reset} ${C.faded}(${resp.names.join(', ')})${C.reset}\n` +
      `  ${C.cyan}${resp.url}${C.reset}\n\n` +
      `  ${C.dim}Web: opens a fill-in modal. Slack: a tappable link. The value is never pasted into chat.${C.reset}\n` +
      `  ${C.dim}Valid for ${describeLinkValidity(resp.expires_at, Date.now())} (until ${resp.expires_at}).${C.reset}\n` +
      `  ${C.dim}Reuse this link until it expires — do not mint a new one while this one is live.${C.reset}\n\n`,
  );
  return 0;
}

export function describeLinkValidity(expiresAtIso: string, nowMs: number): string {
  const expiresMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresMs) || expiresMs <= nowMs) return 'an unknown window';
  const minutes = Math.round((expiresMs - nowMs) / 60_000);
  if (minutes >= 2 * 24 * 60) return `${Math.round(minutes / (24 * 60))} days`;
  if (minutes >= 2 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${Math.max(minutes, 1)} minute${minutes === 1 ? '' : 's'}`;
}

async function secretsUnset(names: string[], opts: CtxOpts): Promise<number> {
  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;
  if (names.length === 0) {
    process.stderr.write(`${status.err('Pass at least one secret name to unset.')}\n`);
    return 2;
  }

  let okCount = 0;
  for (const name of names) {
    try {
      await ctx.client.delete(`/workspaces/${ctx.workspaceId}/secrets/${encodeURIComponent(name)}`);
      okCount += 1;
      process.stdout.write(`${status.ok(`removed ${C.bold}${name}${C.reset}`)}\n`);
    } catch (err) {
      surfaceApiError(err);
      process.stderr.write(`  ${C.dim}└─ for ${name}${C.reset}\n`);
    }
  }
  process.stdout.write(`\n  ${C.dim}${okCount}/${names.length} removed${C.reset}\n\n`);
  return okCount === names.length ? 0 : 1;
}

/**
 * Force a re-push of all workspace secrets to this session's sandbox daemon.
 * Use after setting a secret via the intake link or when secrets are missing
 * from the agent's shell environment despite being set in the store.
 *
 * The backend's propagateProjectSecretsToActiveSandboxes fans out to every
 * active sandbox. This command triggers the same propagation by calling the
 * workspace's secret-propagation endpoint.
 */
async function secretsSync(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;

  try {
    const result = await ctx.client.post<{
      ok: boolean;
      active_sandboxes: number;
      targeted: number;
      synced: number;
      failed: number;
      exported: number;
      results: Array<{
        session_id: string;
        sandbox_id: string | null;
        status: 'synced' | 'failed';
        scope: 'inherit' | 'restricted' | 'none' | null;
        revision: string | null;
        exported: number;
        managed: number | null;
        withheld: number | null;
        agent_env_written: boolean;
        reason?: string;
      }>;
    }>(
      `/workspaces/${ctx.workspaceId}/secrets/sync`,
      {},
    );
    if (json) {
      emitJson(result);
      return result.ok ? 0 : 1;
    }
    if (result.ok) {
      if (result.active_sandboxes === 0) {
        process.stdout.write(`\n${status.ok('No active sandboxes require secret synchronization.')}\n\n`);
        return 0;
      }
      process.stdout.write(
        `\n${status.ok(`Verified ${result.exported} secret export(s) across ${result.synced}/${result.active_sandboxes} active sandbox(es).`)}\n`,
      );
      for (const target of result.results) {
        const scope = target.scope === 'none' ? ' · scope permits zero secrets' : '';
        process.stdout.write(
          `  ${C.dim}${target.session_id}: ${target.exported} exported · revision ${target.revision}${scope}${C.reset}\n`,
        );
      }
      process.stdout.write('\n');
      return 0;
    }

    process.stderr.write(
      `${status.err(`Secret sync incomplete: ${result.synced} synced, ${result.failed} failed.`)}\n`,
    );
    for (const target of result.results.filter((item) => item.status === 'failed')) {
      process.stderr.write(
        `  ${C.dim}${target.session_id || 'workspace'}: ${target.reason ?? 'delivery verification failed'}${C.reset}\n`,
      );
    }
    return 1;
  } catch (err) {
    return surfaceApiError(err);
  }
}
