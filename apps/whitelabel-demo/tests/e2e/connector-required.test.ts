import { describe, expect, test } from 'bun:test';
import {
  type RequiredConnector,
  connectorRemedy,
  connectorRequirement,
  connectorRequirementSummary,
} from '../../src/lib/connector-required';
import { sessionCreateFailure } from '../../src/lib/session-create-failure';

/**
 * The SDK's ApiError shape: the parsed body on `data`, `code` lifted, and
 * `message` derived from the body's `message` (or `error`) by the HTTP client.
 */
const apiError = (body: Record<string, unknown>) =>
  Object.assign(
    new Error(
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : 'HTTP 409',
    ),
    { status: 409, code: body.code, data: body },
  );

const authorizationRequired = (
  connections: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  code: 'CONNECTOR_CONNECTION_REQUIRED',
  message: 'Connect the required connectors before starting this session.',
  connector_connections: connections,
});

const gmailConnection = (strategy: string) => ({
  id: '0f2f2c2e-0000-4000-8000-000000000001',
  slug: 'gmail',
  name: 'Gmail',
  authorization_strategy: strategy,
});

describe('connectorRequirement', () => {
  test('names every connector the 409 lists, with the strategy that decides the remedy', () => {
    const requirement = connectorRequirement(
      apiError(
        authorizationRequired([gmailConnection('user'), { ...gmailConnection('project'), slug: 'slack', name: 'Slack' }]),
      ),
    );
    expect(requirement?.code).toBe('CONNECTOR_CONNECTION_REQUIRED');
    expect(requirement?.connectors).toEqual([
      { alias: 'gmail', name: 'Gmail', strategy: 'user', remedy: 'own_account' },
      { alias: 'slack', name: 'Slack', strategy: 'project', remedy: 'shared_connection' },
    ]);
  });

  test('an unavailable required connection names the alias the prose quotes', () => {
    // The API sends no structured alias on this code — only
    // `Required connector "gmail" is unavailable`. Without the alias the
    // card says "something is missing", which is not a call to action.
    const requirement = connectorRequirement(
      apiError({
        code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
        error: 'Required connector "gmail" is unavailable',
      }),
    );
    expect(requirement?.connectors).toEqual([
      { alias: 'gmail', name: 'gmail', strategy: null, remedy: 'not_configured' },
    ]);
  });

  test('a structured alias wins over the prose, so the API can stop quoting', () => {
    const requirement = connectorRequirement(
      apiError({
        code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
        error: 'Required connector "gmail" is unavailable',
        alias: 'google_mail',
      }),
    );
    expect(requirement?.connectors[0]?.alias).toBe('google_mail');
  });

  test('a body already normalised to camelCase classifies identically', () => {
    const requirement = connectorRequirement(
      apiError({
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        message: 'x',
        connectorConnections: [
          { slug: 'gmail', name: 'Gmail', authorizationStrategy: 'project' },
        ],
      }),
    );
    expect(requirement?.connectors[0]?.remedy).toBe('shared_connection');
  });

  test('CONNECTOR_AUTHORIZATION_REQUIRED is not a platform code and never classifies', () => {
    // This demo classified it for months. It exists nowhere in the API, so the
    // connect prompt behind it was unreachable and every real refusal fell
    // through to a generic toast. Matching it again would resurrect that lie.
    expect(
      connectorRequirement(
        apiError({ code: 'CONNECTOR_AUTHORIZATION_REQUIRED', error: 'connect gmail' }),
      ),
    ).toBeNull();
  });

  test('unknown codes are ignored rather than guessed at', () => {
    expect(connectorRequirement(apiError({ code: 'SOMETHING_NEW', error: 'x' }))).toBeNull();
    expect(connectorRequirement(new Error('network down'))).toBeNull();
    expect(connectorRequirement(null)).toBeNull();
  });

  test('a refusal that names no connector still classifies, with an empty list', () => {
    // Better a card that says "a connector is missing" than a generic toast:
    // the class of failure is known even when the connector is not.
    const requirement = connectorRequirement(apiError(authorizationRequired([])));
    expect(requirement?.code).toBe('CONNECTOR_CONNECTION_REQUIRED');
    expect(requirement?.connectors).toEqual([]);
    expect(requirement?.message.length).toBeGreaterThan(0);
  });

  test('an unusable connection entry is dropped, not rendered as a nameless connector', () => {
    const requirement = connectorRequirement(
      apiError(authorizationRequired([{ name: 'Mystery' }, gmailConnection('project')])),
    );
    expect(requirement?.connectors.map((c) => c.alias)).toEqual(['gmail']);
  });
});

describe('connectorRemedy', () => {
  const connector = (
    strategy: 'project' | 'user' | null,
    remedy: RequiredConnector['remedy'],
  ): RequiredConnector => ({ alias: 'gmail', name: 'Gmail', strategy, remedy });

  test('ONLY a shared (project) connector offers a connect link', () => {
    // The mint endpoint refuses every other strategy with
    // CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH, so a button anywhere else is a
    // button that cannot work.
    expect(
      connectorRemedy(connector('project', 'shared_connection'), { wrapperMode: true })
        .canMintConnectLink,
    ).toBe(true);
    for (const c of [
      connector('user', 'own_account'),
      connector(null, 'not_configured'),
      connector(null, 'unknown'),
    ]) {
      for (const wrapperMode of [true, false, null]) {
        expect(connectorRemedy(c, { wrapperMode }).canMintConnectLink).toBe(false);
      }
    }
  });

  test('a personal connector tells a wrapper user the truth: not yours to connect', () => {
    const copy = connectorRemedy(connector('user', 'own_account'), { wrapperMode: true });
    expect(copy.canMintConnectLink).toBe(false);
    // It must not promise a link, and it must name who CAN act.
    expect(copy.unblockedBy.length).toBeGreaterThan(0);
    expect(copy.unblockedBy.join(' ')).toContain('operator');
  });

  test('in direct mode the same connector points at the account actually holding the key', () => {
    const copy = connectorRemedy(connector('user', 'own_account'), { wrapperMode: false });
    expect(copy.unblockedBy.join(' ').toLowerCase()).toContain('dashboard');
  });

  test('an unconfigured connector never asks the user to connect anything', () => {
    const copy = connectorRemedy(connector(null, 'not_configured'), { wrapperMode: true });
    expect(copy.explanation).toContain('no gmail connector');
    expect(copy.unblockedBy.join(' ')).toContain('manifest');
  });

  test('every remedy names the connector and says the session is blocked on it', () => {
    for (const remedy of ['shared_connection', 'own_account', 'unknown'] as const) {
      for (const wrapperMode of [true, false, null]) {
        const copy = connectorRemedy(connector(null, remedy), { wrapperMode });
        expect(copy.headline).toContain('Gmail');
        expect(copy.explanation).toContain('Gmail');
        // The one sentence the user must not have to infer.
        expect(copy.explanation.toLowerCase()).toContain('cannot start');
      }
    }
  });
});

describe('connectorRequirementSummary and the toast that uses it', () => {
  test('both real codes produce a specific, non-retryable create failure', () => {
    for (const body of [
      authorizationRequired([gmailConnection('project')]),
      {
        code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
        error: 'Required connector "gmail" is unavailable',
      },
    ]) {
      const failure = sessionCreateFailure(apiError(body));
      expect(failure.title).not.toBe('Could not start a session');
      expect(failure.title.toLowerCase()).toContain('gmail');
      // Retrying refuses identically until somebody connects an account.
      expect(failure.retryable).toBe(false);
    }
  });

  test('the toast and the card tell the same story', () => {
    const requirement = connectorRequirement(
      apiError(authorizationRequired([gmailConnection('project')])),
    );
    const summary = connectorRequirementSummary(requirement!);
    const copy = connectorRemedy(requirement!.connectors[0], { wrapperMode: null });
    expect(summary.title).toBe(copy.headline);
    expect(summary.detail).toBe(copy.explanation);
  });

  test('several missing connectors are counted, not silently reduced to the first', () => {
    const summary = connectorRequirementSummary(
      connectorRequirement(
        apiError(
          authorizationRequired([
            gmailConnection('project'),
            { ...gmailConnection('user'), slug: 'slack', name: 'Slack' },
          ]),
        ),
      )!,
    );
    expect(summary.title).toContain('2');
    expect(summary.detail).toContain('Gmail');
    expect(summary.detail).toContain('Slack');
  });

  test('a refusal with no named connector still gets a usable sentence', () => {
    const summary = connectorRequirementSummary(
      connectorRequirement(apiError(authorizationRequired([])))!,
    );
    expect(summary.title.length).toBeGreaterThan(0);
    expect(summary.detail.length).toBeGreaterThan(0);
  });
});
