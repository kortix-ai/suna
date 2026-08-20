import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type AgentGrantConfig,
  agentGrantActionLabel,
  agentGrantCandidateHint,
  agentGrantConfirmation,
  agentGrantErrorMessage,
  agentGrantOutcome,
  agentGrantPlan,
  agentGrantSnippet,
  mergeAgentSecretGrant,
} from './secret-delivery';

/**
 * `SecretsView` cannot be rendered here: `apps/web` has no jsdom and no
 * `@testing-library/react`, and its `bun test` runs WITHOUT `--isolate`, so
 * mocking `@tanstack/react-query` process-wide would corrupt every other file
 * in the run.
 *
 * So the coverage is split in two, and neither half alone proves the fix:
 * `secret-delivery.test.ts` proves what the decision functions DECIDE, and
 * this file pins that the view actually CALLS them — the gap a
 * helpers-in-isolation test cannot see, because a silent return to the old
 * platform-wide `available_sandbox_providers` check, or to an unconditional
 * success toast, still passes it.
 */
const source = readFileSync(join(import.meta.dir, 'secrets-view.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const sliceBetween = (start: string, end: string) => {
  const from = code.indexOf(start);
  const to = code.indexOf(end, from);
  return from < 0 || to < 0 ? '' : code.slice(from, to);
};

describe('SecretsView asks ONE question and writes the three pairs the model names', () => {
  test('the picker is the exposure list, flat and ungrouped', () => {
    // Three values, one question. The five-mechanism list, its two-axis
    // confusion, and the SelectGroup headings it needed are all gone.
    expect(code).toContain('const exposureOptions = secretExposureOptions();');
    expect(code).toContain('Can your code read this value?');
    expect(code).not.toContain('SelectGroup');
    expect(code).not.toContain('SelectLabel');
    expect(code).not.toContain('secretDeliveryOptionGroups');
  });

  test('no user-facing copy names a mechanism as a choice', () => {
    // The §8 release bar: "network boundary" and "HTTPS broker" must not
    // appear as two things a user picks between, anywhere.
    expect(code).not.toContain('Network boundary');
    expect(code).not.toContain('HTTPS broker');
    expect(code).not.toContain('network_boundary');
  });

  test('the stored pair comes from the shared target helper, never inline', () => {
    expect(code).toContain(
      'const { strategy, consumer: nextConsumer } = secretDeliveryTarget(exposure, row);',
    );
  });

  test('an assigned usage renders read-only and never opens the picker', () => {
    expect(code).toContain('const usageAssigned = secretUsageIsAssigned(row?.consumer);');
    expect(code).toContain('{usageAssigned ? (');
    // The connector binding is the one control that stays live on an
    // assigned row: WHICH connectors resolve the secret is a real choice.
    expect(code).toContain("{row?.consumer === 'connector' && (");
  });

  test('the enforced panel is a host list — no header, template, method or path field', () => {
    expect(code).toContain('const enforcedPolicy = buildEnforcedPolicy({');
    expect(code).toContain('secret-dialog-hosts');
    expect(code).not.toContain('secret-dialog-boundary-header');
    expect(code).not.toContain('secret-dialog-boundary-template');
    expect(code).not.toContain('secret-dialog-injection-kind');
    expect(code).not.toContain('secret-dialog-injection-target');
    expect(code).not.toContain('secret-dialog-injection-template');
    expect(code).not.toContain('secret-dialog-broker-methods');
    expect(code).not.toContain('secret-dialog-broker-path');
    expect(code).not.toContain('Header value template');
    expect(code).not.toContain('buildBrokerPolicy');
  });

  test('a legacy slot is shown read-only and removable, never edited in place', () => {
    expect(code).toContain('const legacyDetail = legacyInjectionDetail(');
    expect(code).toContain('{legacyDetail.lines.map((line) => (');
    expect(code).toContain('onClick={() => setLegacyInject(null)}');
    // It rides through the save unless the user removes it.
    expect(code).toContain('legacyInject,');
  });

  test('the availability gate and its feature flag are gone from the page', () => {
    // One mechanism serves every provider, so nothing disables an option and
    // nothing reads the project detail to decide.
    expect(code).not.toContain('networkBoundaryAvailability');
    expect(code).not.toContain('networkBoundaryMode');
    expect(code).not.toContain('networkBoundaryBlockedReason');
    expect(code).not.toContain('available_sandbox_providers');
    expect(code).not.toContain('disabledReason');
  });
});

describe('SecretsView lets the system classify a new secret', () => {
  test('the classification follows every keystroke, not a blur', () => {
    // A pasted `AKIA…` has to move the default at the moment it is pasted.
    expect(code).toContain(
      'const classification = useMemo(() => classifyNewSecret({ key, value }), [key, value]);',
    );
    expect(code).toContain('const exposure = pickedExposure ?? defaultSecretExposure(row, classification);');
  });

  test('an explicit pick latches and is never overwritten by the next keystroke', () => {
    expect(code).toContain('const [pickedExposure, setPickedExposure] = useState<SecretExposure | null>(null);');
    expect(code).toContain('onValueChange={(next) => setPickedExposure(next as SecretExposure)}');
  });

  test('the prefilled hosts follow the classification until the user edits them', () => {
    expect(code).toContain(
      "const hosts = editedHosts ?? (row ? storedHosts : classification.hosts.join('\\n'));",
    );
  });

  test('both recognitions are stated on screen, not silently applied', () => {
    expect(code).toContain('{classification.signingNote}');
    expect(code).toContain('{`Recognized: ${classification.modelProvider.label} key`}');
  });
});

describe('SecretsView warns when no agent can receive the secret', () => {
  test('the row carries the API verdict through the reader, never a raw field read', () => {
    expect(code).toContain('deliveryBlockedReason: secretDeliveryBlockedReason(item),');
    expect(code).toContain('deliveryBlockedReason: SecretDeliveryBlockedReason | null;');
    // Placeholder rows for manifest keys with no stored secret know nothing.
    expect(code).toContain('deliveryBlockedReason: null,');
  });

  test('the table row shows the warning only for the modes that need a grant', () => {
    expect(code).toContain(
      'shouldWarnMissingAgentGrant(row.deliveryBlockedReason, row.strategy, row.consumer) && (',
    );
    expect(code).toContain('>No agent grant</span>');
  });

  test('the dialog renders the notice and the kortix.yaml fix', () => {
    expect(code).toMatch(
      /const grantNotice =\s*row &&\s*shouldWarnMissingAgentGrant\(row\.deliveryBlockedReason, strategy, nextConsumer\) &&\s*!grant\.isSuccess\s*\?\s*missingAgentGrantNotice\(row\.identifier\)\s*:\s*null;/,
    );
    expect(code).toContain('{grantNotice.body}');
    expect(code).toContain('{grantManifest}');
  });

  test('a completed grant retires the warning the open dialog is still showing', () => {
    // `row` is the parent's snapshot from when the dialog opened. Refetching
    // the list cannot change it, so the notice has to stand down on its own.
    expect(code).toContain('!grant.isSuccess');
  });
});

describe('SecretsView turns the missing-grant warning into a grant action', () => {
  const grantMutation = sliceBetween('const grant = useMutation({', 'const startGrant');
  const startGrant = sliceBetween('const startGrant = () => {', '};');

  test('the scan found the grant mutation and its trigger', () => {
    // Guard the guards: an empty string passes `.not.toContain` silently.
    expect(grantMutation.length).toBeGreaterThan(0);
    expect(startGrant.length).toBeGreaterThan(0);
  });

  test('the agent list comes from the shared project-config hook', () => {
    expect(code).toContain('const projectConfig = useProjectConfig(projectId);');
    expect(code).toContain('const grantPlan = agentGrantPlan(projectConfig, grantIdentifier);');
  });

  test('the grant goes through the SDK client, never a raw fetch', () => {
    expect(grantMutation).toContain('grantSecretToAgent(projectId, grantIdentifier, agent)');
    // A bare `fetch(` call, not `secretsQuery.refetch()`.
    expect(code).not.toMatch(/(^|[^\w.])fetch\(/);
  });

  test('an ungoverned project passes the confirm before any commit', () => {
    expect(startGrant).toContain('if (grantPlan.adoptsGovernance) {');
    expect(startGrant.indexOf('setGrantConfirmOpen(true);')).toBeGreaterThan(-1);
    expect(startGrant.indexOf('setGrantConfirmOpen(true);')).toBeLessThan(
      startGrant.indexOf('grant.mutate('),
    );
    expect(code).toContain('<ConfirmDialog');
    expect(code).toContain('description={grantConfirmation.body}');
  });

  test('the toast reports what the server did, not what was asked', () => {
    expect(grantMutation).toContain('const outcome = agentGrantOutcome(result);');
    expect(grantMutation).toContain('infoToast(outcome.message, options)');
    expect(grantMutation).toContain('successToast(outcome.message, options)');
  });

  test('both queries behind the warning refetch on success', () => {
    // The verdict is computed from the manifest the project detail carries, so
    // the secrets list alone cannot clear the warning.
    expect(grantMutation).toContain(
      'queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });',
    );
    expect(grantMutation).toContain('onSaved();');
  });

  test('a failure stays on screen beside the snippet', () => {
    expect(code).toContain('{agentGrantErrorMessage(grant.error)}');
  });

  test('the snippet follows the chosen agent', () => {
    expect(code).toMatch(
      /agentGrantSnippet\(\s*grantIdentifier,\s*selectedGrantAgent,\s*selectedGrantCandidate\?\.currentSecrets,?\s*\)/,
    );
  });

  test('the action cannot submit the secret form by accident', () => {
    // The banner sits inside the dialog's <form>; a default-type button would
    // save the secret instead of granting it.
    expect(code).toMatch(/type="button"[\s\S]{0,240}onClick=\{startGrant\}/);
  });
});

describe('SecretsView reports a save that did not reach the running sessions', () => {
  const onSuccess = sliceBetween('onSuccess: (result, plan) => {', 'onError:');

  test('the scan found the save mutation success handler', () => {
    // Guard the guards: an empty string passes `.not.toContain` silently.
    expect(onSuccess.length).toBeGreaterThan(0);
  });

  test('a failed delivery sync warns instead of reporting a plain success', () => {
    expect(onSuccess).toContain(
      'const syncWarning = secretDeliverySyncWarning(plan.finalIdentifier, result);',
    );
    expect(onSuccess).toMatch(
      /if \(syncWarning\) \{\s*warningToast\(syncWarning\.message, \{ description: syncWarning\.description \}\);\s*\} else \{\s*successToast\(`Saved \$\{plan\.finalIdentifier\}`\);\s*\}/,
    );
  });

  test('the success toast fires only in the else branch', () => {
    expect(onSuccess.match(/successToast\(/g)).toHaveLength(1);
    expect(code).toContain('import { errorToast, infoToast, successToast, warningToast } from');
  });
});

/**
 * The panel is the last surface before someone tests the boundary by hand. The
 * text has to come from the helper, because a hardcoded copy here drifts from
 * the hosts the user typed and stops naming a host they can actually probe.
 */
describe('SecretsView states the echo caveat in the enforced panel', () => {
  const panel = sliceBetween('{needsHosts && (', "{row?.consumer === 'connector' && (");

  test('the scan found the enforced-hosts panel', () => {
    expect(panel.length).toBeGreaterThan(0);
  });

  test('the caveat is derived from the declared hosts, not hardcoded', () => {
    // One symptom now: the relay returns 200 with `[REDACTED]` in place of the
    // value, on every provider. A literal here would drift from the host the
    // user typed and stop naming one they can actually probe.
    expect(code).toContain('const echoNotice = enforcedEchoNotice(hosts);');
    expect(panel).toContain('title={echoNotice.title}');
    expect(panel).toContain('{echoNotice.body}');
    expect(panel).toContain('{echoNotice.probe}');
    expect(panel).toContain('href={echoNotice.docsHref}');
  });

  test('the old sentence that never said what the block looks like is gone', () => {
    expect(code).not.toContain('Secret values echoed by an upstream response are blocked');
  });
});

describe('agentGrantPlan', () => {
  const declarative = (
    agents: AgentGrantConfig['agents'],
    extra: Partial<AgentGrantConfig> = {},
  ): AgentGrantConfig => ({ agent_discovery: 'declarative', agents, ...extra });
  const ungoverned = (
    agents: AgentGrantConfig['agents'],
    extra: Partial<AgentGrantConfig> = {},
  ): AgentGrantConfig => ({ agent_discovery: 'opencode', agents, ...extra });

  test('a project with no config offers nothing and still demands the confirm', () => {
    const plan = agentGrantPlan(undefined, 'BOUNDARY_TEST');
    expect(plan.candidates).toEqual([]);
    expect(plan.preselected).toBeNull();
    expect(plan.adoptsGovernance).toBe(true);
  });

  test('an ungoverned project lists its agents and adopts governance', () => {
    const plan = agentGrantPlan(
      ungoverned([{ name: 'build' }, { name: 'support' }], { default_agent: 'support' }),
      'BOUNDARY_TEST',
    );
    expect(plan.candidates.map((candidate) => candidate.name)).toEqual(['build', 'support']);
    expect(plan.preselected).toBe('support');
    expect(plan.adoptsGovernance).toBe(true);
  });

  test('a governed project needs no governance adoption', () => {
    const plan = agentGrantPlan(
      declarative([{ name: 'support', scope: { env: ['OTHER'] } }]),
      'BOUNDARY_TEST',
    );
    expect(plan.adoptsGovernance).toBe(false);
    expect(plan.preselected).toBe('support');
  });

  test('an unreadable discovery mode confirms rather than guesses', () => {
    // `detail-capability-filter` blanks `agent_discovery` for a member without
    // the agents capability. Silence there must not skip the footgun confirm.
    const plan = agentGrantPlan({ agent_discovery: null, agents: [] }, 'BOUNDARY_TEST');
    expect(plan.adoptsGovernance).toBe(true);
  });

  test('an existing list entry is matched case-insensitively', () => {
    const plan = agentGrantPlan(
      declarative([{ name: 'support', scope: { env: ['boundary_test'] } }]),
      'BOUNDARY_TEST',
    );
    expect(plan.candidates[0]?.alreadyGranted).toBe(true);
    expect(plan.candidates[0]?.currentSecrets).toEqual(['boundary_test']);
  });

  test('an agent on "secrets: all" is grantable, and the narrowing is visible', () => {
    const plan = agentGrantPlan(
      declarative([{ name: 'support', scope: { env: 'all' } }]),
      'BOUNDARY_TEST',
    );
    expect(plan.candidates[0]).toEqual({
      name: 'support',
      alreadyGranted: false,
      currentSecrets: 'all',
    });
  });

  test('a project that lists no agent falls back to its default agent', () => {
    const plan = agentGrantPlan(ungoverned([], { default_agent: 'build' }), 'BOUNDARY_TEST');
    expect(plan.candidates).toEqual([
      { name: 'build', alreadyGranted: false, currentSecrets: null },
    ]);
    expect(plan.preselected).toBe('build');
  });

  test('the legacy default-agent field is read when the canonical one is absent', () => {
    const plan = agentGrantPlan(
      { agent_discovery: 'opencode', agents: [], open_code_default_agent: 'legacy' },
      'BOUNDARY_TEST',
    );
    expect(plan.preselected).toBe('legacy');
  });

  test('no agents and no default agent leaves nothing to grant to', () => {
    const plan = agentGrantPlan(ungoverned([]), 'BOUNDARY_TEST');
    expect(plan.candidates).toEqual([]);
    expect(plan.preselected).toBeNull();
  });

  test('repeated and blank agent names are dropped, manifest order is kept', () => {
    const plan = agentGrantPlan(
      ungoverned([{ name: 'support' }, { name: '  ' }, { name: 'support' }, { name: 'build' }]),
      'BOUNDARY_TEST',
    );
    expect(plan.candidates.map((candidate) => candidate.name)).toEqual(['support', 'build']);
    expect(plan.preselected).toBe('support');
  });

  test('a default agent outside the declared list is not preselected', () => {
    const plan = agentGrantPlan(
      declarative([{ name: 'support' }], { default_agent: 'ghost' }),
      'BOUNDARY_TEST',
    );
    expect(plan.preselected).toBe('support');
  });
});

describe('mergeAgentSecretGrant', () => {
  test('an agent with no list starts one', () => {
    expect(mergeAgentSecretGrant(undefined, 'BOUNDARY_TEST')).toEqual(['BOUNDARY_TEST']);
  });

  test('"all" cannot carry an explicit grant, so the hand-edit starts fresh', () => {
    // The endpoint expands `all` to every project identifier. The client sees
    // only its own slice of them, so the snippet stays minimal instead of
    // printing a list that would revoke a private override it cannot see.
    expect(mergeAgentSecretGrant('all', 'BOUNDARY_TEST')).toEqual(['BOUNDARY_TEST']);
  });

  test('an existing list is appended to, in order', () => {
    expect(mergeAgentSecretGrant(['A_KEY', 'B_KEY'], 'BOUNDARY_TEST')).toEqual([
      'A_KEY',
      'B_KEY',
      'BOUNDARY_TEST',
    ]);
  });

  test('an entry that differs only in case keeps its existing spelling', () => {
    expect(mergeAgentSecretGrant(['boundary_test'], 'BOUNDARY_TEST')).toEqual(['boundary_test']);
  });
});

describe('agentGrantSnippet', () => {
  test('without a chosen agent it keeps the copyable placeholder', () => {
    expect(agentGrantSnippet('BOUNDARY_TEST', null)).toBe(
      'kortix_version: 2\nagents:\n  my-agent:\n    secrets: [BOUNDARY_TEST]',
    );
  });

  test('with a chosen agent it shows that agent and the merged list', () => {
    expect(agentGrantSnippet('BOUNDARY_TEST', 'support', ['A_KEY'])).toBe(
      'kortix_version: 2\nagents:\n  support:\n    secrets: [A_KEY, BOUNDARY_TEST]',
    );
  });
});

describe('agentGrantActionLabel', () => {
  const plan = (names: string[]) => ({
    candidates: names.map((name) => ({ name, alreadyGranted: false, currentSecrets: null })),
    preselected: names[0] ?? null,
    adoptsGovernance: false,
  });

  test('a single agent needs no picker, so the button names it', () => {
    expect(agentGrantActionLabel(plan(['support']), 'support')).toBe('Grant to support');
  });

  test('several agents put the name in the picker, not the button', () => {
    expect(agentGrantActionLabel(plan(['support', 'build']), 'support')).toBe('Grant');
  });

  test('no selection still reads as the action', () => {
    expect(agentGrantActionLabel(plan([]), null)).toBe('Grant');
  });
});

describe('agentGrantCandidateHint', () => {
  test('an agent that already lists the secret says so', () => {
    expect(
      agentGrantCandidateHint({
        name: 'support',
        alreadyGranted: true,
        currentSecrets: ['BOUNDARY_TEST'],
      }),
    ).toBe('Already lists this secret.');
  });

  test('an "all" agent states what the grant does to the shorthand', () => {
    // `grantSecretToAgentV2` expands `all` to every project identifier rather
    // than narrowing it, and the hint must not claim the opposite.
    expect(
      agentGrantCandidateHint({ name: 'support', alreadyGranted: false, currentSecrets: 'all' }),
    ).toBe(
      'Runs on "secrets: all". The grant expands that to an explicit list of the project secrets.',
    );
  });

  test('an ordinary agent needs no hint', () => {
    expect(
      agentGrantCandidateHint({ name: 'support', alreadyGranted: false, currentSecrets: null }),
    ).toBeNull();
  });
});

describe('agentGrantConfirmation', () => {
  const confirmation = agentGrantConfirmation('BOUNDARY_TEST', 'support');

  test('it names the agent and the secret', () => {
    expect(confirmation.title).toBe('Start governing agents in kortix.yaml');
    expect(confirmation.body).toContain('support');
    expect(confirmation.body).toContain('BOUNDARY_TEST');
    expect(confirmation.confirmLabel).toBe('Grant to support');
  });

  test('it states the default-deny consequence in plain words', () => {
    // The whole reason this dialog exists: the first `agents:` block revokes
    // every project secret from every agent it does not name.
    expect(confirmation.body).toContain('no project secrets');
    expect(confirmation.body).toContain('sandbox');
  });
});

describe('agentGrantOutcome', () => {
  test('an unchanged manifest reports no change', () => {
    const outcome = agentGrantOutcome({
      identifier: 'BOUNDARY_TEST',
      agent: 'support',
      already_granted: true,
      adopted_governance: false,
    });
    expect(outcome.tone).toBe('info');
    expect(outcome.message).toBe('support already receives BOUNDARY_TEST');
    expect(outcome.description).toBe('kortix.yaml was not changed.');
  });

  test('a plain grant reports the commit', () => {
    const outcome = agentGrantOutcome({
      identifier: 'BOUNDARY_TEST',
      agent: 'support',
      already_granted: false,
      adopted_governance: false,
    });
    expect(outcome.tone).toBe('success');
    expect(outcome.message).toBe('Granted BOUNDARY_TEST to support');
    expect(outcome.description).toBeUndefined();
  });

  test('a grant that adopted governance says what changed for every other agent', () => {
    const outcome = agentGrantOutcome({
      identifier: 'BOUNDARY_TEST',
      agent: 'support',
      already_granted: false,
      adopted_governance: true,
    });
    expect(outcome.tone).toBe('success');
    expect(outcome.description).toContain('no project secrets');
  });
});

describe('agentGrantErrorMessage', () => {
  test('a v1 manifest is sent to the file, not to a retry', () => {
    expect(agentGrantErrorMessage({ code: 'manifest_v1_unsupported', message: 'nope' })).toBe(
      'This project uses a kortix_version 1 manifest. Edit kortix.toml directly, or upgrade the project to kortix_version 2.',
    );
  });

  test('a disabled secret names the delivery policy as the blocker', () => {
    expect(agentGrantErrorMessage({ code: 'secret_not_grantable', message: 'nope' })).toBe(
      'This secret is disabled. Change its delivery policy before granting it.',
    );
  });

  test('any other failure surfaces the server message', () => {
    expect(agentGrantErrorMessage(new Error('agent_not_found'))).toBe('agent_not_found');
  });

  test('a failure with no message still says something actionable', () => {
    expect(agentGrantErrorMessage(null)).toBe('Could not grant the secret.');
  });
});
