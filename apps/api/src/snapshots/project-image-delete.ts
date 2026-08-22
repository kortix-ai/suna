import { isExactPpwarmImageName } from './ppwarm-names';
import { getSandboxProvider } from './providers';

/** Delete one resolved ppwarm image without resolving or touching its base template. */
export async function deleteProjectSandboxImage(
  snapshotName: string,
  providerName: string,
): Promise<{ deleted: boolean; snapshotName: string }> {
  if (!isExactPpwarmImageName(snapshotName)) {
    throw new Error(`Refusing to delete non-project sandbox image: ${snapshotName}`);
  }
  const provider = getSandboxProvider(providerName);
  const before = await provider.getSnapshotState(snapshotName);
  await provider.deleteSnapshot(snapshotName);
  return {
    deleted: before === 'active' || before === 'building',
    snapshotName,
  };
}
