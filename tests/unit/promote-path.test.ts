/**
 * The promote path's shape, pinned as source text.
 *
 * Every assertion here is a rule paid for by a real release. `prod`'s only
 * required check is `full suite + quality gates` (`tests-release.yml`), and on
 * 2026-09-17 release PR #7336 became PERMANENTLY unmergeable — by anyone,
 * including an org owner — because two of these rules did not exist yet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(__dirname, '..', '..', '.github', 'workflows');
const read = (name: string) => readFileSync(join(WORKFLOWS, name), 'utf8');

describe('promote cuts the release from what staging SERVES', () => {
  const promote = read('promote.yml');

  it('defaults the source to the deployed staging commit, not the branch tip', () => {
    // `origin/staging` moves the instant a PR merges and can sit ahead of the
    // deployed halves for the length of a build + deploy. RELEASE_SOURCE_SHA
    // must equal what is deployed or `target-smoke.ts` throws on every shard.
    expect(promote).toContain('Resolve the promote source (default = what staging SERVES)');
    expect(promote).toContain('https://staging-api.kortix.com/v1/health');
    expect(promote).toContain('https://gateway-staging.kortix.com/health');
    // The `ref` input must NOT default back to a branch name.
    expect(promote).not.toMatch(/description: 'Source ref to promote \(default staging\)'/);
    expect(promote).toMatch(/ref:\s*\n\s*description: 'Source ref\/SHA to promote \(default: the SHA staging is SERVING\)'/);
  });

  it('requires the api and the gateway to agree before promoting', () => {
    // A split-brain staging (one half rolled, one not) cannot satisfy the gate,
    // which asserts BOTH halves equal RELEASE_SOURCE_SHA.
    expect(promote).toContain('Deployed staging is split-brain');
  });

  it('checks out the resolved source and proves it came from staging', () => {
    expect(promote).toContain('ref: ${{ steps.src.outputs.ref }}');
    expect(promote).toContain('Require the source to be reachable from staging');
    expect(promote).toContain('git merge-base --is-ancestor "$sha" origin/staging');
  });

  it('reads the explicit override from the input, never from its own output', () => {
    // A self-referential `INPUT_REF: steps.src.outputs.ref` on the resolve step
    // makes an explicit ref unreachable.
    const resolveStep = promote.slice(
      promote.indexOf('Resolve the promote source'),
      promote.indexOf('Checkout ${{ steps.src.outputs.ref }}'),
    );
    expect(resolveStep).toContain('INPUT_REF: ${{ inputs.ref }}');
    expect(resolveStep).not.toContain('INPUT_REF: ${{ steps.src.outputs.ref }}');
  });
});

describe('the release gate starts without a human click', () => {
  const promote = read('promote.yml');

  it('approves its own gate run, which GitHub holds for a bot-authored PR', () => {
    // Measured 2026-09-17: the repo was ALREADY on
    // `fork-pr-contributor-approval: first_time_contributors` and gate run
    // 35242868705 still landed `action_required`, because the release PR's
    // actor is `github-actions[bot]`. v0.13.18 and v0.13.21 both waited there.
    expect(promote).toContain('Approve the release gate run');
    expect(promote).toContain('/approve');
    expect(promote).toContain("select(.name == \"Tests - release\")");
  });

  it('has the permission that approval needs', () => {
    expect(promote).toMatch(/permissions:\n(?:\s*#.*\n|\s+\S+: \S+\n)*\s+actions: write/);
  });

  it('never fails the promote over an approval it could not give', () => {
    const step = promote.slice(promote.indexOf('Approve the release gate run'));
    expect(step.slice(0, 400)).toContain('continue-on-error: true');
  });
});

describe('staging holds still while a release is in flight', () => {
  const staging = read('deploy-staging.yml');

  it('refuses to deploy while a release PR into prod is open', () => {
    expect(staging).toContain('Refuse to move staging while a release PR is open');
    expect(staging).toContain('--base prod --state open');
    expect(staging).toContain('staging is frozen');
  });

  it('keeps an explicit force escape for an emergency', () => {
    expect(staging).toContain('force_during_release');
    expect(staging).toContain("if: ${{ inputs.force_during_release != true }}");
  });

  it('can read pull requests, or the freeze cannot see one', () => {
    expect(staging).toMatch(/permissions:\n(?:\s+\S+: \S+\n)*\s+pull-requests: read/);
  });

  it('records that a workflow_run workflow only takes effect from the default branch', () => {
    // The 2026-09-10 learning: `workflow_run` loads the DEFAULT branch's copy,
    // so this gate is inert until it is on `main`.
    expect(staging).toContain('GitHub loads it from the');
  });
});

describe('the release gate runs before the release, not on it', () => {
  const staging = read('deploy-staging.yml');
  const gate = read('tests-release.yml');

  it('dispatches the gate against the SHA staging now serves', () => {
    expect(staging).toContain('release-gate-dry-run');
    expect(staging).toContain('gh workflow run tests-release.yml --ref staging -f "expected_sha=$SOURCE_SHA"');
  });

  it('never fails a successful staging deploy', () => {
    const job = staging.slice(staging.indexOf('  release-gate-dry-run:'));
    expect(job).toContain('continue-on-error: true');
  });

  it('has a kill switch that needs no code change', () => {
    expect(staging).toContain("vars.STAGING_PREPROMOTE_GATE != 'off'");
  });

  it('targets the dry-run input the gate already accepts', () => {
    expect(gate).toContain('expected_sha');
    expect(gate).toMatch(/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*expected_sha:/);
  });

  it('keeps the required check name the prod ruleset asks for', () => {
    // Renaming this job silently un-gates production.
    expect(gate).toContain('name: full suite + quality gates');
  });
});

describe('a release PR does not re-run checks its tree already passed', () => {
  it('ci runs on main and staging PRs, never on a release PR', () => {
    expect(read('ci.yml')).toMatch(/pull_request:\n(?:\s*#.*\n)*\s*branches: \[main, staging\]/);
  });

  it('security scanners stay off release PRs, where they gate nothing', () => {
    expect(read('security-scan.yml')).toMatch(/pull_request:\n(?:\s*#.*\n)*\s*branches: \[main, staging\]/);
  });

  it('codeql scans PRs into main only, but KEEPS every push baseline', () => {
    const codeql = read('codeql.yml');
    // The push baselines are what every branch's alert diff is measured
    // against (`promote-pr-scanner-baselines`) — narrowing them is a
    // regression, not a saving.
    expect(codeql).toContain('push:\n    branches: [main, staging, prod]');
    expect(codeql).toContain('pull_request:\n    branches: [main]');
  });

  it('runs the whole suite on a main PR and integration lanes on a staging PR', () => {
    const pr = read('tests-pr.yml');
    expect(pr).toContain("if: github.base_ref == 'main' || github.event_name == 'workflow_dispatch'");
    expect(pr).toContain('mode: full');
    expect(pr).toContain('mode: core');
    expect(pr).toContain('mode: packages');
    // The browser lanes are the 10-minute tail; the release gate re-runs those
    // journeys against deployed staging.
    expect(pr).not.toContain('mode: browser');
  });

  it('leaves the shared lane definitions untouched', () => {
    // tests.yml is the crown-jewel gate for `main`. F4 reuses its existing
    // `mode` semantics rather than editing it.
    const tests = read('tests.yml');
    expect(tests).toContain("inputs.mode == 'full' || inputs.mode == matrix.mode");
    expect(tests).toContain('--browser-only --browser-shard=1/2');
    expect(tests).toContain('--browser-only --browser-shard=2/2');
  });
});

describe('the release record survives an npm outage', () => {
  const prod = read('deploy-prod.yml');
  const needsLine =
    prod.split('\n').find((l) => l.includes('needs:') && l.includes('frontend-auth-proof')) ?? '';

  it('does not let a failed npm publish skip the tag, Release and changelog', () => {
    // v0.13.6: publish-llm-catalog failed, so github-release + the VERSION
    // syncs + announce + installers were ALL skipped while prod served the
    // release. Recovered by hand.
    expect(needsLine).not.toContain('publish-sdk');
    expect(needsLine).not.toContain('publish-agent-tunnel');
  });

  it('still waits for the CLI binaries it publishes as release assets', () => {
    expect(needsLine).toContain('build-cli');
    expect(prod).toContain('name: cli-binaries');
  });

  it('still waits for prod to actually serve the release', () => {
    expect(needsLine).toContain('deploy-ecs');
    expect(needsLine).toContain('verify-live-version');
    expect(needsLine).toContain('frontend-auth-proof');
  });
});
