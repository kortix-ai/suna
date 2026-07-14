import type { EnterpriseImageRole, EnterpriseReleaseManifest } from './release-contract.ts';
import type { CommandRunner } from './process.ts';

export type CustomerRepositories = Record<EnterpriseImageRole, string>;

export interface MirroredImage {
  role: EnterpriseImageRole;
  source: string;
  destination: string;
  digest: string;
}

export function parseCustomerRepositories(value: string): CustomerRepositories {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`KORTIX_ECR_REPOSITORIES is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('KORTIX_ECR_REPOSITORIES must be an object');
  }
  const record = parsed as Record<string, unknown>;
  const result = {} as CustomerRepositories;
  for (const role of ['api', 'frontend', 'gateway'] as const) {
    const repository = record[role];
    if (typeof repository !== 'string' || !repository.includes('.dkr.ecr.') || repository.includes('@') || repository.includes(':latest')) {
      throw new Error(`KORTIX_ECR_REPOSITORIES.${role} must be an untagged private ECR repository URL`);
    }
    result[role] = repository.replace(/\/$/, '');
  }
  return result;
}

export function verifyAndMirrorImages(
  runner: CommandRunner,
  manifest: EnterpriseReleaseManifest,
  cosignPublicKeyPath: string,
  repositories: CustomerRepositories,
  region: string,
): MirroredImage[] {
  verifyTooling(runner);
  for (const role of ['api', 'frontend', 'gateway'] as const) {
    const image = manifest.images[role];
    runner.run('cosign', [
      'verify', '--key', cosignPublicKeyPath, '--insecure-ignore-tlog=false', image.source,
    ]);
  }

  const registry = registryHost(repositories.api);
  for (const repository of Object.values(repositories)) {
    if (registryHost(repository) !== registry) throw new Error('all customer ECR repositories must use one registry');
  }
  const password = runner.run('aws', ['ecr', 'get-login-password', '--region', region]).trim();
  if (!password) throw new Error('AWS returned an empty ECR login password');
  runner.run('crane', ['auth', 'login', registry, '--username', 'AWS', '--password-stdin'], {
    input: `${password}\n`, redact: [password],
  });

  return (['api', 'frontend', 'gateway'] as const).map((role) => {
    const image = manifest.images[role];
    const destination = `${repositories[role]}:${manifest.version}`;
    const existing = optionalDigest(runner, destination);
    if (existing && existing !== image.digest) {
      throw new Error(`immutable destination ${destination} already exists with unexpected digest ${existing}`);
    }
    if (!existing) runner.run('crane', ['copy', image.source, destination]);
    const mirroredDigest = runner.run('crane', ['digest', destination]).trim();
    if (mirroredDigest !== image.digest) {
      throw new Error(`mirrored ${role} digest mismatch: expected ${image.digest}, received ${mirroredDigest}`);
    }
    return { role, source: image.source, destination, digest: mirroredDigest };
  });
}

function verifyTooling(runner: CommandRunner): void {
  runner.run('cosign', ['version']);
  runner.run('crane', ['version']);
}

function optionalDigest(runner: CommandRunner, image: string): string | null {
  try {
    const value = runner.run('crane', ['digest', image]).trim();
    return value || null;
  } catch {
    return null;
  }
}

function registryHost(repository: string): string {
  const host = repository.split('/', 1)[0];
  if (!host || !/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(host)) {
    throw new Error(`invalid private ECR repository URL: ${repository}`);
  }
  return host;
}
