import type { SandboxTemplateProvider } from './provider-coverage';

type ImageKind = 'default' | 'meta' | 'pi';
type Build = (options: { provider: string; source: 'startup' }) => Promise<{
  snapshotName: string;
  built: boolean;
}>;
type Outcome = { kind: ImageKind; provider: SandboxTemplateProvider } & (
  { snapshotName: string; built: boolean } | { error: string }
);

export async function prebuildStartupImages(
  providers: readonly SandboxTemplateProvider[],
  builds: Record<ImageKind, Build> & { report: (outcome: Outcome) => void },
): Promise<void> {
  const jobs = providers.flatMap(provider => {
    const kinds: ImageKind[] = provider === 'daytona' ? ['default', 'meta', 'pi'] : ['default', 'meta'];
    return kinds.map(async kind => {
      try {
        const result = await builds[kind]({ provider, source: 'startup' });
        builds.report({ kind, provider, snapshotName: result.snapshotName, built: result.built });
      } catch (error) {
        builds.report({ kind, provider, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  await Promise.all(jobs);
}
