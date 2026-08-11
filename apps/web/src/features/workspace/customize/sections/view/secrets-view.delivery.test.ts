import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('SecretsView gates network-boundary delivery on the ACTIVE provider', () => {
  test('the availability comes from the helper, not from the platform provider list', () => {
    expect(code).toContain(
      'const networkBoundary = networkBoundaryAvailability(workspaceDetailQuery.data?.workspace);',
    );
    // The old gate read what the DEPLOYMENT offers. A workspace on Daytona
    // injects nothing, so that check offered an impossible mode.
    expect(code).not.toContain('available_sandbox_providers');
  });

  test('the dialog receives the availability and forwards it to the option builder', () => {
    expect(code).toContain('networkBoundary={networkBoundary}');
    expect(code).toContain('networkBoundary: NetworkBoundaryAvailability;');
    expect(sliceBetween('secretDeliveryOptions(', ');')).toContain('networkBoundary,');
  });

  test('the disabled option states its own reason instead of one fixed sentence', () => {
    expect(code).toMatch(
      /description=\{\s*option\.disabledReason\s*\?\s*`\$\{option\.description\} \$\{option\.disabledReason\}`/,
    );
    expect(code).not.toContain('Not available in this deployment.');
  });

  test('an already-egress secret on a non-Platinum workspace says so in the panel', () => {
    expect(code).toContain(
      'const networkBoundaryNotice = networkBoundaryBlockedReason(networkBoundary);',
    );
    expect(code).toContain('{networkBoundaryNotice && (');
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
      'shouldWarnMissingAgentGrant(row.deliveryBlockedReason, row.strategy) && (',
    );
    expect(code).toContain('>No agent grant</span>');
  });

  test('the dialog renders the notice and the kortix.yaml fix', () => {
    expect(code).toMatch(
      /const grantNotice =\s*row && shouldWarnMissingAgentGrant\(row\.deliveryBlockedReason, strategy\)\s*\?\s*missingAgentGrantNotice\(row\.identifier\)\s*:\s*null;/,
    );
    expect(code).toContain('{grantNotice.body}');
    expect(code).toContain('{grantNotice.manifest}');
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
    expect(code).toContain('import { errorToast, successToast, warningToast } from');
  });
});

describe('SecretsView states the cost of an empty header template', () => {
  test('both template fields name the 401 consequence', () => {
    expect(code.match(/reject with 401\./g)).toHaveLength(2);
  });
});
