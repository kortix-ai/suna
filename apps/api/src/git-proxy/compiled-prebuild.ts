import { resolveCommitSha } from '../projects/git';
import type { GitBackedProject } from '../projects/git/types';
import { refreshMirror } from '../projects/git/mirror';
import {
  buildCompiledPiRuntimeArtifact,
  listPiAgentNames,
  resolvePiDefaultAgentName,
  type StoredCompiledPiRuntimeArtifact,
} from './compiled-pi-runtime-artifact';
import {
  buildCompiledCheckoutArtifact,
  type CompiledCheckoutArtifact,
} from './compiled-checkout';
import {
  buildCompiledRuntimeArtifact,
  type StoredCompiledRuntimeArtifact,
} from './compiled-runtime-artifact';

interface CompiledPrebuildDependencies {
  buildCheckout: typeof buildCompiledCheckoutArtifact;
  buildRuntime: typeof buildCompiledRuntimeArtifact;
  resolveTip: typeof resolveCommitSha;
}

const defaults: CompiledPrebuildDependencies = {
  buildCheckout: buildCompiledCheckoutArtifact,
  buildRuntime: buildCompiledRuntimeArtifact,
  resolveTip: resolveCommitSha,
};

export interface CompiledBootArtifacts {
  checkout: CompiledCheckoutArtifact;
  runtime: StoredCompiledRuntimeArtifact;
}

export async function prebuildCompiledBootArtifacts(
  project: GitBackedProject,
  ref: string,
  sourceSha: string,
  runtimeRepoUrl: string,
  dependencies: CompiledPrebuildDependencies = defaults,
): Promise<CompiledBootArtifacts> {
  const [checkout, runtime] = await Promise.all([
    dependencies.buildCheckout(project, ref, sourceSha, runtimeRepoUrl),
    dependencies.buildRuntime(project, ref, sourceSha),
  ]);
  return { checkout, runtime };
}

export async function prebuildDefaultBranchArtifacts(
  project: GitBackedProject,
  runtimeRepoUrl: string,
  dependencies: CompiledPrebuildDependencies = defaults,
): Promise<CompiledBootArtifacts> {
  // Same stale-tip trap as the pi prebuild below: `resolveCommitSha` refreshes
  // the mirror WITHOUT force and the interval is 60 s, but this runs right
  // after a push that has just touched the mirror — so the refresh no-ops and
  // the tip resolves to the PRE-push commit. The push then prebuilds the wrong
  // sha and the first session on the new one compiles on demand, which is the
  // whole thing this prebuild exists to prevent. Proven on the pi path
  // (2026-08-29): pushing a fourth agent prebuilt three artifacts for the
  // pre-push sha and none for the pushed one.
  await refreshMirror(project, true).catch(() => {});
  const sourceSha = await dependencies.resolveTip(project, project.defaultBranch);
  return prebuildCompiledBootArtifacts(
    project,
    project.defaultBranch,
    sourceSha,
    runtimeRepoUrl,
    dependencies,
  );
}

/**
 * Compile the pi worker runtime for the default branch tip. Same shape as
 * `prebuildDefaultBranchArtifacts` above, and deliberately a SEPARATE entry
 * point: the pi artifact is per-project opt-in (the `pi_worker` feature flag),
 * while the opencode artifacts follow the platform-wide
 * KORTIX_COMPILED_BOOT_MODE — the caller composes the two gates.
 */
export async function prebuildDefaultBranchPiRuntime(
  project: GitBackedProject,
  resolveTip: typeof resolveCommitSha = resolveCommitSha,
): Promise<StoredCompiledPiRuntimeArtifact> {
  // FORCE the mirror forward first. `resolveCommitSha` refreshes without
  // force, and `refreshIntervalMs()` is 60 s — but this runs immediately after
  // a push, which has just touched the mirror, so the unforced refresh is a
  // no-op and the tip resolves to the PREVIOUS commit. The push then prebuilt
  // the wrong sha and the first session on the new one compiled on demand,
  // which is the whole thing this prebuild exists to avoid. Caught on
  // pi.kortix.com 2026-08-29: pushing `echo-probe` prebuilt 3 agents for the
  // pre-push sha and none for the pushed one.
  await refreshMirror(project, true).catch(() => {});
  const sourceSha = await resolveTip(project, project.defaultBranch);
  // Bake the DEFAULT agent by name. The artifact is keyed per agent, so
  // prebuilding under the empty name would warm an entry no session asks for.
  const defaultAgent = await resolvePiDefaultAgentName(project, sourceSha).catch(() => "");
  const primary = await buildCompiledPiRuntimeArtifact(
    project,
    project.defaultBranch,
    sourceSha,
    defaultAgent,
  );

  // Then EVERY other declared agent, so none of them compiles on its first
  // session. Sequential and best-effort on purpose: this runs inside a push,
  // the default agent is already in hand, and one broken agent must not fail
  // the push or the artifact the caller is waiting for.
  const others = (await listPiAgentNames(project, sourceSha).catch(() => [])).filter(
    (name) => name && name !== defaultAgent,
  );
  for (const agent of others) {
    await buildCompiledPiRuntimeArtifact(project, project.defaultBranch, sourceSha, agent).catch(
      (error) => {
        console.warn(
          `[compiled-boot] prebuild of agent ${agent} for ${project.projectId} failed`,
          error,
        );
      },
    );
  }
  return primary;
}
