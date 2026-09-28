import { and, desc, eq } from 'drizzle-orm';
import { connectionCredentials, connectorCalls, connectorConnections, connectors } from '@kortix/db';
import { db } from '../../src/shared/db';
import {
  api, check, driveConnectorSdk, driveExistingSessionGrantRefresh, driveMcp, expectCli,
  FIXTURE_SLUG, PIPEDREAM_SLUG, getAgentToken, projectId, seedCallableAction, sessionId, userId,
} from '../e2e-cli-agent-token';

async function projectAndFixture(): Promise<void> {
  await expectCli('token reports session token context', ['token'], { stdout: /session token|session/ });
  await expectCli('whoami works with agent token', ['whoami'], { stdout: /kortix|agent|session/i });
  await expectCli('system-skills list works', ['system-skills'], { stdout: /kortix-system/ });
  await expectCli('projects info works for bound project', ['projects', 'info', projectId], { stdout: new RegExp(projectId) });
  await expectCli('projects ls fails closed for project-scoped agent token', ['projects', 'ls'], {
    code: 1,
    stderr: /Project-scoped token cannot list projects|project-scoped token/i,
  });
  await expectCli('sessions ls works', ['sessions', 'ls'], { stdout: new RegExp(sessionId.slice(0, 8)) });
  await expectCli('sessions info accepts the displayed short id', ['sessions', 'info', sessionId.slice(0, 8)], {
    stdout: new RegExp(sessionId),
  });
  await expectCli('sessions status stays bounded when runtime activity is unavailable', [
    'sessions',
    'status',
    '--json',
  ]);

  await expectCli('secrets set writes through the real API', ['secrets', 'set', 'CLI_AGENT_E2E=value']);
  await expectCli('secrets ls reads persisted metadata', ['secrets', 'ls'], { stdout: /CLI_AGENT_E2E/ });
  await expectCli('secrets request creates a setup link', ['secrets', 'request', 'CLI_AGENT_E2E_LINK'], {
    stdout: /https?:\/\//,
  });
  await expectCli(
    'connectors add --apply commits and materializes an HTTP connector',
    ['connectors', 'add', FIXTURE_SLUG, '--provider', 'http', '--base-url', 'https://postman-echo.com', '--auth-type', 'bearer', '--apply'],
    { stdout: /live on the project/ },
  );
  await expectCli('connectors sync reconciles the manifest', ['connectors', 'sync'], { stdout: /Synced/ });
  await expectCli('connectors credential reads from stdin', ['connectors', 'credential', FIXTURE_SLUG, '-'], {
    input: 'agent-e2e-fixture-token\n',
    stdout: /Credential set/,
  });

  const [connection] = await db
    .select({ id: connectorConnections.connectionId, status: connectorConnections.status })
    .from(connectorConnections)
    .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, FIXTURE_SLUG)))
    .limit(1);
  const [credential] = connection
    ? await db
        .select({ id: connectionCredentials.credentialId })
        .from(connectionCredentials)
        .where(eq(connectionCredentials.connectionId, connection.id))
        .limit(1)
    : [];
  check(
    'connector credential created a persisted active connection',
    connection?.status === 'active' && !!credential?.id,
  );

  await seedCallableAction();
  await driveExistingSessionGrantRefresh();
  await driveConnectorSdk();
  const inheritedCatalog = await expectCli(
    'unconfigured session scope inherits the active project connection',
    ['connectors', 'ls', '--session', sessionId],
    { stdout: new RegExp(FIXTURE_SLUG) },
  );
  check('inherited connector catalog stdout is valid JSON', (() => {
    try { JSON.parse(inheritedCatalog.stdout); return true; } catch { return false; }
  })());
  await expectCli(
    'inherited project connection is callable with the agent token',
    ['connectors', 'call', `${FIXTURE_SLUG}.get`, '{"q":"inherited-agent-token"}'],
    { stdout: /inherited-agent-token/ },
  );
  await expectCli(
    'sessions scope creates an explicit empty connector scope',
    ['sessions', 'scope', sessionId, '--no-connectors', '--json'],
    { stdout: /"connector_bindings"\s*:\s*\{\}/ },
  );
  await expectCli(
    'explicit empty connector scope returns an empty agent catalog',
    ['connectors', 'ls', '--session', sessionId],
    { stdout: /"connectors"\s*:\s*\[\s*\]/ },
  );
  await expectCli(
    'explicit empty connector scope denies a forced call',
    ['connectors', 'call', `${FIXTURE_SLUG}.get`, '{"q":"must-not-run"}'],
    { code: 1, stdout: /connector_not_found|not found/i },
  );
}

async function connections(): Promise<string> {
  let selectedConnectionId = '';
  const createdConnection = await expectCli(
    'connections add creates a second project connection',
    ['connectors', 'connections', 'add', FIXTURE_SLUG, 'Secondary', '--owner', 'project', '--metadata', '{"purpose":"agent-token-e2e"}', '--json'],
    { stdout: /"connection_id"/ },
  );
  try {
    selectedConnectionId = JSON.parse(createdConnection.stdout)?.connection_id ?? '';
  } catch {
    // The assertion below reports invalid JSON without exposing credentials.
  }
  check('connections add prints a reusable connection_id', !!selectedConnectionId);
  const listedConnections = await expectCli(
    'connections ls reads the second connection',
    ['connectors', 'connections', 'ls', '--json'],
    { stdout: selectedConnectionId ? new RegExp(selectedConnectionId) : /"connections"/ },
  );
  check('connections ls stdout is valid JSON', (() => {
    try { JSON.parse(listedConnections.stdout); return true; } catch { return false; }
  })());
  await expectCli(
    'connections ls --all reads the manage-gated roster',
    ['connectors', 'connections', 'ls', '--all', '--json'],
    { stdout: selectedConnectionId ? new RegExp(selectedConnectionId) : /"connections"/ },
  );
  if (!selectedConnectionId) throw new Error('second connection id was not returned');
  await expectCli(
    'connections credential reads the second credential from stdin',
    ['connectors', 'connections', 'credential', selectedConnectionId, '-'],
    { input: 'agent-e2e-secondary-token\n', stdout: /Credential set/ },
  );
  await expectCli(
    'connections default selects the second connection',
    ['connectors', 'connections', 'default', selectedConnectionId],
    { stdout: /Set as default/ },
  );
  await expectCli(
    'connections revoke disables the second connection',
    ['connectors', 'connections', 'revoke', selectedConnectionId],
    { stdout: /Revoked/ },
  );
  await expectCli(
    'connections activate restores the second connection',
    ['connectors', 'connections', 'activate', selectedConnectionId],
    { stdout: /Activated/ },
  );
  await expectCli(
    'sessions scope binds the second connection to the agent session',
    ['sessions', 'scope', sessionId, '--connector', `${FIXTURE_SLUG}=${selectedConnectionId}`],
    { stdout: new RegExp(selectedConnectionId) },
  );
  await expectCli('connectors rename persists a display name', ['connectors', 'rename', FIXTURE_SLUG, 'Agent HTTP']);
  await expectCli('connectors mode keeps the shared connection mode', ['connectors', 'mode', FIXTURE_SLUG, 'shared']);
  await expectCli('connectors policy set persists approval requirement', [
    'connectors',
    'policy',
    FIXTURE_SLUG,
    'set',
    'get',
    'require_approval',
  ]);
  await expectCli('connectors policy ls reads the rule', ['connectors', 'policy', FIXTURE_SLUG, 'ls'], {
    stdout: /get.*require_approval/s,
  });
  return selectedConnectionId;
}

async function approvals(): Promise<void> {
  const pendingApproval = await expectCli(
    'connector call returns a machine-readable approval handoff',
    ['connectors', 'call', `${FIXTURE_SLUG}.get`, '{"q":"approve-agent-token"}'],
    { stdout: /"status"\s*:\s*"pending_approval"/ },
  );
  let approvalExecutionId = '';
  try {
    const payload = JSON.parse(pendingApproval.stdout);
    approvalExecutionId = payload.execution_id ?? '';
    check(
      'approval handoff includes execution_id and approval_url',
      !!approvalExecutionId && /^https?:\/\//.test(payload.approval_url ?? ''),
    );
  } catch {
    check('approval handoff stdout is valid JSON', false, pendingApproval.stdout);
  }
  if (!approvalExecutionId) throw new Error('approval execution id was not returned');
  const agentApproval = await api(
    `/projects/${projectId}/approvals/${approvalExecutionId}`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
    getAgentToken(),
  );
  check(
    'session-scoped agent token cannot approve its own connector call',
    agentApproval.status === 403 && agentApproval.body?.code === 'APPROVAL_REQUIRES_HUMAN',
    `${agentApproval.status} ${agentApproval.text}`,
  );
  const humanApproval = await api(`/projects/${projectId}/approvals/${approvalExecutionId}`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approve' }),
  });
  check(
    'human session launcher approves the pending connector call',
    humanApproval.status === 200 && humanApproval.body?.ok === true,
    `${humanApproval.status} ${humanApproval.text}`,
  );
  await expectCli(
    'approved exact connector call executes once on retry',
    ['connectors', 'call', `${FIXTURE_SLUG}.get`, '{"q":"approve-agent-token"}'],
    { stdout: /approve-agent-token/ },
  );

  const pendingDenial = await expectCli(
    'changed connector arguments require a new approval',
    ['connectors', 'call', `${FIXTURE_SLUG}.get`, '{"q":"deny-agent-token"}'],
    { stdout: /"status"\s*:\s*"pending_approval"/ },
  );
  let denialExecutionId = '';
  try {
    denialExecutionId = JSON.parse(pendingDenial.stdout)?.execution_id ?? '';
  } catch {
    // The assertion below reports invalid JSON without exposing credentials.
  }
  check(
    'changed connector arguments return a distinct approval execution_id',
    !!denialExecutionId && denialExecutionId !== approvalExecutionId,
  );
  if (!denialExecutionId) throw new Error('denial execution id was not returned');
  const humanDenial = await api(`/projects/${projectId}/approvals/${denialExecutionId}`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'deny' }),
  });
  check(
    'human session launcher denies the second pending connector call',
    humanDenial.status === 200 && humanDenial.body?.ok === true,
    `${humanDenial.status} ${humanDenial.text}`,
  );
}

async function catalogAndAudit(selectedConnectionId: string): Promise<void> {
  await expectCli('connectors policy rm removes the rule', ['connectors', 'policy', FIXTURE_SLUG, 'rm', 'get']);
  await expectCli('connectors policy clear is idempotent', ['connectors', 'policy', FIXTURE_SLUG, 'clear']);
  await expectCli('connectors ls lists project connectors', ['connectors', 'ls'], { stdout: new RegExp(FIXTURE_SLUG) });
  const sessionList = await expectCli(
    'connectors ls --session emits the agent machine catalog',
    ['connectors', 'ls', '--session', sessionId],
    { stdout: new RegExp(FIXTURE_SLUG) },
  );
  check('connectors ls --session stdout is valid JSON', (() => {
    try { JSON.parse(sessionList.stdout); return true; } catch { return false; }
  })());
  await expectCli('connectors show returns one action schema', ['connectors', 'show', `${FIXTURE_SLUG}.get`], {
    stdout: /inputSchema/,
  });
  await expectCli('connectors discover finds the seeded action', ['connectors', 'discover', 'echo query value'], {
    stdout: new RegExp(`${FIXTURE_SLUG}\\.get`),
  });
  await expectCli('connectors call reaches a real upstream', [
    'connectors',
    'call',
    `${FIXTURE_SLUG}.get`,
    '{"q":"agent-token-cli"}',
  ], { stdout: /agent-token-cli/ });
  const [audit] = await db
    .select({
      status: connectorCalls.status,
      sessionId: connectorCalls.sessionId,
      actingUserId: connectorCalls.actingUserId,
      actionPath: connectorCalls.actionPath,
      connectionId: connectorCalls.connectionId,
    })
    .from(connectorCalls)
    .where(and(eq(connectorCalls.projectId, projectId), eq(connectorCalls.actionPath, `${FIXTURE_SLUG}.get`)))
    .orderBy(desc(connectorCalls.createdAt))
    .limit(1);
  check(
    'connector call used the selected connection and persisted a session-bound audit row',
    audit?.status === 'ok' &&
      audit.sessionId === sessionId &&
      audit.actingUserId === userId &&
      audit.connectionId === selectedConnectionId,
    JSON.stringify(audit ?? null),
  );
}

async function pipedream(): Promise<void> {
  await expectCli('connectors apps searches Pipedream catalogue', ['connectors', 'apps', 'github', '--json'], {
    stdout: /github/i,
  });
  await expectCli(
    'connectors add --apply creates a Pipedream connector',
    ['connectors', 'add', PIPEDREAM_SLUG, '--provider', 'pipedream', '--app', 'github', '--apply'],
  );
  const pipedreamConnection = await expectCli(
    'connections add creates a Pipedream connection',
    ['connectors', 'connections', 'add', PIPEDREAM_SLUG, 'GitHub E2E', '--owner', 'project', '--json'],
    { stdout: /"connection_id"/ },
  );
  let pipedreamConnectionId = '';
  try {
    pipedreamConnectionId = JSON.parse(pipedreamConnection.stdout)?.connection_id ?? '';
  } catch {
    // The assertion below reports invalid JSON without exposing credentials.
  }
  check('Pipedream connection returns a reusable connection_id', !!pipedreamConnectionId);
  if (pipedreamConnectionId) {
    await expectCli(
      'connections connect starts Pipedream for one connection',
      ['connectors', 'connections', 'connect', pipedreamConnectionId, '--json'],
      { stdout: /connectUrl|token|app/ },
    );
    await expectCli(
      'connections finalize reports the Pipedream connection state',
      ['connectors', 'connections', 'finalize', pipedreamConnectionId, '--json'],
      { code: [0, 1], stdout: /"connected"/ },
    );
  }
  await expectCli('connectors connect mints the new connection link', ['connectors', 'connect', PIPEDREAM_SLUG, '--expires', '10'], {
    stdout: /https?:\/\//,
  });
}

async function gatewayAndAccess(): Promise<void> {
  await driveMcp();

  await expectCli(
    'gateway test sends a real model request with the agent token',
    [
      'gateway',
      'test',
      'glm-5.3-flash',
      '--prompt',
      'Reply with exactly connector-gateway-agent-e2e',
    ],
    { stdout: /connector-gateway-agent-e2e/ },
  );
  const gatewayLogs = await expectCli(
    'gateway logs lists the real request',
    ['gateway', 'logs', '--limit', '1', '--json'],
    { stdout: /request_id/ },
  );
  let gatewayRequestId = '';
  try {
    gatewayRequestId = JSON.parse(gatewayLogs.stdout)?.logs?.[0]?.request_id ?? '';
  } catch {
    // The assertion below reports invalid JSON without exposing credentials.
  }
  check('gateway logs prints a request_id that an agent can copy', !!gatewayRequestId);
  if (gatewayRequestId) {
    await expectCli(
      'gateway logs resolves the displayed request_id',
      ['gateway', 'logs', gatewayRequestId, '--json'],
      { stdout: new RegExp(gatewayRequestId) },
    );
  }

  const readable: Array<[string, string[]]> = [
    ['agents models', ['agents', 'models']],
    ['providers ls', ['providers', 'ls']],
    ['channels status', ['channels', 'status']],
    ['channels manifest', ['channels', 'manifest']],
    ['marketplace list', ['marketplace', 'list', '--limit', '1']],
    ['gateway routing get', ['gateway', 'routing', 'get']],
    ['gateway usage', ['gateway', 'usage']],
    ['gateway logs', ['gateway', 'logs']],
    ['sandboxes ls', ['sandboxes', 'ls']],
    ['sandboxes health', ['sandboxes', 'health']],
    ['grants ls', ['grants', 'ls']],
    ['access ls', ['access', 'ls']],
    ['access pending', ['access', 'pending']],
    ['triggers ls', ['triggers', 'ls']],
    ['files ls', ['files', 'ls']],
    ['cr ls', ['cr', 'ls']],
  ];
  for (const [name, args] of readable) await expectCli(name, args);

  const accountOnly: Array<[string, string[]]> = [
    ['accounts current', ['accounts', 'current']],
    ['roles ls', ['roles', 'ls']],
    ['audit ls', ['audit', 'ls']],
  ];
  for (const [name, args] of accountOnly) {
    await expectCli(`${name} rejects the project-scoped agent token`, args, {
      code: [1, 2],
      stderr: /account-scoped|Project-scoped|active account|project-scoped/i,
    });
  }

  await expectCli('connectors rm --apply removes the Pipedream fixture', ['connectors', 'rm', PIPEDREAM_SLUG, '--apply']);
  await expectCli('connectors rm --apply removes the HTTP fixture', ['connectors', 'rm', FIXTURE_SLUG, '--apply']);
}

export async function commandMatrix(): Promise<void> {
  await projectAndFixture();
  const selectedConnectionId = await connections();
  await approvals();
  await catalogAndAudit(selectedConnectionId);
  await pipedream();
  await gatewayAndAccess();
}
