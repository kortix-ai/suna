import { resolveCommitSha } from '../projects/git';
import type { GitBackedProject } from '../projects/git/types';
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
