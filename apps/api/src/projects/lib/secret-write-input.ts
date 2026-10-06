/**
 * The POST /:projectId/secrets validation ladder, extracted from routes/secrets.ts.
 *
 * A pure resolver: it reads only the request body and one caller-supplied
 * flag, does no I/O, and returns either the parsed write input or the exact
 * response the route must send. The checks that need the database — the
 * network-boundary destination conflict, the existing-row lookup behind
 * value-required, the secrets_egress gate and the identifier-key conflict —
 * stay in the route handler (routes/secrets.ts), which runs them in the same
 * order after this resolver returns ok.
 *
 * `isAgentSession` replaces `isProjectSessionPrincipal(c)` because that
 * predicate reads request context; the route computes it once and passes the
 * boolean, keeping this module free of Hono types.
 */
import { SecretConsumerSchema, type SecretConsumer } from '@kortix/api-contract';
import type { SecretEgressPolicy } from '@kortix/db';
import { networkBoundaryPolicyError } from '../../secrets/network-boundary';
import { parseEgressPolicy } from '../../secrets/strategy';
import { isValidIdentifier, isValidSecretName } from '../secrets';
import { CODEX_AUTH_JSON_SECRET_NAME, isTeamsInstallSecretName, normalizeString } from './serializers';

export type SecretWriteInput = {
  name: string;
  identifier: string;
  value: string | null;
  explicitStrategy: 'runtime' | 'broker' | 'egress' | 'denied' | undefined;
  explicitConsumer: SecretConsumer | null | undefined;
  explicitPolicy: SecretEgressPolicy | null;
  explicitHandlePrefix: string | null;
};

export type SecretWriteInputResult =
  | { ok: true; input: SecretWriteInput }
  | { ok: false; status: 400 | 403; body: Record<string, unknown> };

/**
 * The strategy→consumer contract, encoded once: which consumers a strategy
 * accepts, and the consumer a bare strategy is completed with. `broker` is
 * the one strategy with several consumers and no default — it requires an
 * explicit one.
 */
const STRATEGY_CONSUMERS: Record<
  'runtime' | 'broker' | 'egress' | 'denied',
  {
    accepts: readonly (SecretConsumer | null)[];
    default: SecretConsumer | null | undefined;
    error: string;
  }
> = {
  runtime: {
    accepts: ['sandbox'],
    default: 'sandbox',
    error: 'runtime creation requires the sandbox consumer',
  },
  broker: {
    accepts: ['llm_gateway', 'connector', 'http_broker'],
    default: undefined,
    error: 'broker creation requires a supported server consumer',
  },
  egress: {
    accepts: ['network'],
    default: 'network',
    error: 'egress creation requires the network consumer',
  },
  denied: {
    accepts: [null],
    default: null,
    error: 'denied creation cannot have a consumer',
  },
};

export function resolveSecretWriteInput(
  body: Record<string, unknown>,
  isAgentSession: boolean,
): SecretWriteInputResult {
  const name = normalizeString(body.name)?.toUpperCase();
  if (!name) return { ok: false, status: 400, body: { error: 'name is required' } };
  if (!isValidSecretName(name)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'name must be a valid env var name (A-Z, 0-9, _; max 64 chars)' },
    };
  }
  if (name.startsWith('KORTIX_')) {
    return {
      ok: false,
      status: 400,
      body: { error: 'KORTIX_* names are reserved for platform/runtime-managed variables' },
    };
  }
  if (isTeamsInstallSecretName(name)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'MS_TEAMS_* names are managed by the Microsoft Teams connection' },
    };
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return {
      ok: false,
      status: 400,
      body: { error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` },
    };
  }

  // Identifier — the unique-per-project handle agents grant + the UI shows.
  // Defaults to the KEY when omitted (the simple/migrated case).
  const identifier = normalizeString(body.identifier) ?? name;
  if (!isValidIdentifier(identifier)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'identifier must be alphanumeric (A-Z, 0-9, _, ., -; max 128 chars)' },
    };
  }

  const value = typeof body.value === 'string' ? body.value : null;
  const requestedConsumer =
    body.consumer === undefined ? undefined : SecretConsumerSchema.nullable().safeParse(body.consumer);
  if (requestedConsumer && !requestedConsumer.success) {
    return { ok: false, status: 400, body: { error: 'consumer is invalid' } };
  }
  const requestedConsumerData = requestedConsumer?.success
    ? requestedConsumer.data
    : undefined;
  const requestedStrategy = body.strategy;
  if (
    requestedStrategy !== undefined &&
    !['runtime', 'broker', 'egress', 'denied'].includes(String(requestedStrategy))
  ) {
    return {
      ok: false,
      status: 400,
      body: { error: 'secret creation supports runtime, broker, egress, or denied delivery' },
    };
  }
  const explicitStrategy = requestedStrategy as
    | 'runtime'
    | 'broker'
    | 'egress'
    | 'denied'
    | undefined;
  if (explicitStrategy !== undefined) {
    const contract = STRATEGY_CONSUMERS[explicitStrategy];
    // An invalid consumer body already returned above, so an unparsed consumer
    // here means it was not sent at all — the bare-strategy case.
    if (!requestedConsumer?.success) {
      if (contract.default === undefined) {
        return { ok: false, status: 400, body: { error: contract.error } };
      }
    } else if (!contract.accepts.includes(requestedConsumer.data)) {
      return { ok: false, status: 400, body: { error: contract.error } };
    }
  }
  if (requestedStrategy === undefined && requestedConsumer !== undefined) {
    return { ok: false, status: 400, body: { error: 'consumer requires a strategy' } };
  }
  // Agent sessions must not choose a delivery policy. This mirrors the
  // PUT /:identifier/strategy guard below: an agent-session PAT that can create
  // a secret must not also set egress/broker/denied delivery or an outbound
  // host list, because a later session mints a spendable handle against that
  // policy — widening a host list is exactly the exfil vector. Two shapes stay
  // allowed, the same two an agent-minted setup link can write
  // (writeSharedProjectSecret): a plain runtime/sandbox secret, and a
  // connector-scoped one (broker/connector, no host list) whose value only
  // the connector gateway spends.
  const agentAllowedDelivery =
    body.egress_policy === undefined &&
    (requestedStrategy === undefined || requestedStrategy === 'runtime'
      ? requestedConsumerData === undefined || requestedConsumerData === 'sandbox'
      : requestedStrategy === 'broker' && requestedConsumerData === 'connector');
  if (isAgentSession && !agentAllowedDelivery) {
    return { ok: false, status: 403, body: { error: 'Agent sessions cannot change secret delivery policy' } };
  }
  // The server does NOT infer delivery from the secret's NAME.
  //
  // It used to: a create with no `strategy`/`consumer` whose name matched any
  // provider credential env in the models.dev catalogue was stamped
  // `broker`/`llm_gateway`. That catalogue has 204 providers and one of them,
  // `github-copilot`, claims `GITHUB_TOKEN` — so an ordinary GitHub PAT was
  // classified as a model credential and withheld from the sandbox. The user
  // set a secret, the agent could not read it, and nothing said why (prod
  // 2026-08-27). Any name a provider happens to claim had the same problem;
  // carving out one name would only move it.
  //
  // The callers that actually mean "model credential" all say so explicitly —
  // web provider-connect, the custom-provider form, `kortix providers set`, and
  // the Codex OAuth flow, which writes its row directly with `strategyLocked`.
  // Every other caller means "a secret for my sandbox", which is now what they
  // get. The web secrets manager already sent `runtime`/`sandbox` outright, so
  // this also ends a split-brain where the same name landed differently
  // depending on which surface created it.
  const explicitConsumer =
    requestedConsumer === undefined
      ? explicitStrategy
        ? STRATEGY_CONSUMERS[explicitStrategy].default
        : undefined
      : requestedConsumerData;
  let explicitPolicy = null;
  if (explicitConsumer === 'http_broker' || explicitConsumer === 'network') {
    const policy = parseEgressPolicy(body.egress_policy);
    if (!policy.ok) {
      return { ok: false, status: 400, body: { error: policy.error, code: 'secret_delivery_policy_invalid' } };
    }
    if (explicitConsumer === 'http_broker' && policy.policy.backend !== 'kortix_fetch') {
      return { ok: false, status: 400, body: { error: 'HTTP broker requires the kortix_fetch backend' } };
    }
    if (explicitConsumer === 'network') {
      const boundaryError = networkBoundaryPolicyError(policy.policy);
      if (boundaryError) {
        return {
          ok: false,
          status: 400,
          body: { error: boundaryError, code: 'secret_delivery_policy_invalid' },
        };
      }
      // The destination-conflict read needs the database and stays in the
      // route handler; it runs here for network only, before handle_prefix.
    }
    explicitPolicy = policy.policy;
  } else if (body.egress_policy !== undefined) {
    return { ok: false, status: 400, body: { error: 'This consumer does not accept an outbound policy' } };
  }
  const explicitHandlePrefix =
    explicitConsumer === 'http_broker' && typeof body.handle_prefix === 'string'
      ? body.handle_prefix.trim()
      : null;
  if (explicitHandlePrefix && explicitHandlePrefix.length > 48) {
    return { ok: false, status: 400, body: { error: 'handle_prefix must contain at most 48 characters' } };
  }

  return {
    ok: true,
    input: {
      name,
      identifier,
      value,
      explicitStrategy,
      explicitConsumer,
      explicitPolicy,
      explicitHandlePrefix,
    },
  };
}
