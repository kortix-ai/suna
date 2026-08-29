import { resolveCommitSha } from '../projects/git';
import type { GitBackedProject } from '../projects/git/types';
import {
  buildCompiledPiRuntimeArtifact,
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
  const sourceSha = await resolveTip(project, project.defaultBranch);
  // Bake the DEFAULT agent by name. The artifact is keyed per agent, so
  // prebuilding under the empty name would warm an entry no session asks for.
  const agent = await resolvePiDefaultAgentName(project, sourceSha).catch(() => "");
  return buildCompiledPiRuntimeArtifact(project, project.defaultBranch, sourceSha, agent);
}
