import type { CreatedProject } from '../core/types';

export interface PooledRepository {
  project: CreatedProject;
}

export interface RepositoryProjectInput {
  name: string;
  accountId?: string;
}

export interface RegisterRepositoryProjectInput extends RepositoryProjectInput {
  sourceProjectId: string;
  branch: string;
}

export interface RepositoryPoolOperations {
  provision(): Promise<PooledRepository>;
  registerProject(input: RegisterRepositoryProjectInput): Promise<CreatedProject>;
}

export class RunRepositoryPool {
  private repositoryPromise: Promise<PooledRepository> | null = null;
  private branchSequence = 0;

  constructor(
    private readonly runId: string,
    private readonly operations: RepositoryPoolOperations,
  ) {}

  sharedProject(): Promise<CreatedProject> {
    return this.repository().then(({ project }) => project);
  }

  async project(input: RepositoryProjectInput): Promise<CreatedProject> {
    const repository = await this.repository();
    const branch = this.nextBranch();
    return this.operations.registerProject({
      ...input,
      sourceProjectId: repository.project.id,
      branch,
    });
  }

  private repository(): Promise<PooledRepository> {
    if (!this.repositoryPromise) {
      this.repositoryPromise = this.operations.provision();
    }
    return this.repositoryPromise;
  }

  private nextBranch(): string {
    this.branchSequence += 1;
    const runSlug = this.runId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .slice(0, 80);
    return `ke2e-${runSlug}-${this.branchSequence}`;
  }
}
