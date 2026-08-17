import { describe, expect, test } from 'bun:test';
import { LightsailAppHostingBackend } from './lightsail';

function commandClient(responses: Record<string, unknown | unknown[]>) {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const indices: Record<string, number> = {};
  return {
    commands,
    client: {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        commands.push({ name, input: command.input });
        const response = responses[name];
        if (!Array.isArray(response)) return response ?? {};
        const index = indices[name] ?? 0;
        indices[name] = index + 1;
        return response[Math.min(index, response.length - 1)] ?? {};
      },
    },
  };
}

describe('AWS Lightsail Apps hosting backend', () => {
  test('creates one tagged service and an ECR-backed authenticated deployment', async () => {
    const pullerArn = 'arn:aws:iam::701935371203:role/amazon/lightsail/us-west-2/containers/kortix-test-app-111111111111/private-repo-access/role';
    const lightsail = commandClient({
      CreateContainerServiceCommand: {
        containerService: { state: 'READY', url: 'https://service.cs.amazonlightsail.com/' },
      },
      UpdateContainerServiceCommand: {},
      CreateContainerServiceDeploymentCommand: {},
      GetContainerServicesCommand: [
        { containerServices: [] },
        { containerServices: [{ state: 'READY' }] },
        {
          containerServices: [{
            state: 'READY',
            privateRegistryAccess: {
              ecrImagePullerRole: { isActive: true, principalArn: pullerArn },
            },
          }],
        },
        {
          containerServices: [{
            state: 'RUNNING',
            url: 'https://service.cs.amazonlightsail.com/',
            currentDeployment: { state: 'ACTIVE' },
          }],
        },
      ],
    });
    const ecr = commandClient({
      GetRepositoryPolicyCommand: {
        policyText: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Sid: 'ExistingPolicy', Effect: 'Allow', Principal: '*', Action: 'ecr:GetDownloadUrlForLayer' }],
        }),
      },
      SetRepositoryPolicyCommand: {},
    });
    const sleeps: number[] = [];
    const endpointRequests: string[] = [];
    const backend = new LightsailAppHostingBackend({
      lightsail: lightsail.client as never,
      codebuild: commandClient({}).client as never,
      ecr: ecr.client as never,
      s3: commandClient({}).client as never,
      region: 'us-west-2',
      buildBucket: 'builds',
      ecrRepositoryUri: '123.dkr.ecr.us-west-2.amazonaws.com/apps',
      codebuildProject: 'apps-build',
      environment: 'test',
      controlSecret: 'control-secret-for-tests',
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      fetch: (async (url) => {
        endpointRequests.push(String(url));
        return new Response(endpointRequests.length === 1 ? 'warming' : '', {
          status: endpointRequests.length === 1 ? 503 : 200,
        });
      }) as typeof fetch,
    });

    const result = await backend.createRuntime({
      runtimeId: '11111111-1111-4111-8111-111111111111',
      deploymentId: '22222222-2222-4222-8222-222222222222',
      imageReference: '123.dkr.ecr.us-west-2.amazonaws.com/apps:deployment-2',
      machine: { cpuCores: 1, memoryGb: 2, diskGb: 10 },
      envVars: { NODE_ENV: 'production' },
      name: 'demo',
      accountId: 'account-1',
      userId: 'user-1',
    });

    expect(result.externalId).toBe('kortix-test-app-111111111111');
    const create = lightsail.commands.find((command) => command.name === 'CreateContainerServiceCommand');
    expect(create?.input).toMatchObject({ power: 'medium', scale: 1 });
    const deploy = lightsail.commands.find(
      (command) => command.name === 'CreateContainerServiceDeploymentCommand',
    );
    expect(deploy?.input).toMatchObject({
      publicEndpoint: {
        containerName: 'app',
        containerPort: 8080,
        healthCheck: { path: '/__kortix/health' },
      },
    });
    expect(JSON.stringify(deploy?.input)).toContain('KORTIX_APP_ORIGIN_TOKEN');
    expect(result.originTokenHash).toHaveLength(64);
    const commandNames = lightsail.commands.map((command) => command.name);
    const updateIndex = commandNames.indexOf('UpdateContainerServiceCommand');
    const deployIndex = commandNames.indexOf('CreateContainerServiceDeploymentCommand');
    expect(commandNames.slice(updateIndex + 1, deployIndex)).toContain('GetContainerServicesCommand');
    expect(sleeps).toContain(30_000);
    expect(ecr.commands.map((command) => command.name)).toEqual([
      'GetRepositoryPolicyCommand',
      'SetRepositoryPolicyCommand',
    ]);
    const policy = JSON.parse(String(
      ecr.commands.find((command) => command.name === 'SetRepositoryPolicyCommand')?.input.policyText,
    ));
    expect(policy.Statement).toContainEqual(expect.objectContaining({ Sid: 'ExistingPolicy' }));
    expect(policy.Statement).toContainEqual({
      Sid: 'AllowLightsailPull-kortix-test-app-111111111111',
      Effect: 'Allow',
      Principal: { AWS: pullerArn },
      Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
    });
    expect(endpointRequests).toEqual([
      'https://service.cs.amazonlightsail.com/__kortix/health',
      'https://service.cs.amazonlightsail.com/__kortix/health',
    ]);
  });

  test('deletes the service on stop so disabled capacity cannot continue billing', async () => {
    const lightsail = commandClient({
      DeleteContainerServiceCommand: {},
      GetContainerServicesCommand: { containerServices: [] },
    });
    const ecr = commandClient({
      GetRepositoryPolicyCommand: {
        policyText: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AllowLightsailPull-kortix-test-app-111111111111',
              Effect: 'Allow',
              Principal: { AWS: 'arn:aws:iam::701935371203:role/puller' },
              Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
            },
            { Sid: 'ExistingPolicy', Effect: 'Allow', Principal: '*', Action: 'ecr:GetDownloadUrlForLayer' },
          ],
        }),
      },
      SetRepositoryPolicyCommand: {},
    });
    const backend = new LightsailAppHostingBackend({
      lightsail: lightsail.client as never,
      codebuild: commandClient({}).client as never,
      ecr: ecr.client as never,
      s3: commandClient({}).client as never,
      region: 'us-west-2',
      buildBucket: 'builds',
      ecrRepositoryUri: 'repo',
      codebuildProject: 'build',
      environment: 'test',
      controlSecret: 'control-secret-for-tests',
      sleep: async () => {},
    });
    await backend.stop('kortix-test-app-111111111111');
    expect(lightsail.commands.map((command) => command.name)).toEqual([
      'DeleteContainerServiceCommand',
      'GetContainerServicesCommand',
    ]);
    const updatedPolicy = JSON.parse(String(
      ecr.commands.find((command) => command.name === 'SetRepositoryPolicyCommand')?.input.policyText,
    ));
    expect(updatedPolicy.Statement).toEqual([
      { Sid: 'ExistingPolicy', Effect: 'Allow', Principal: '*', Action: 'ecr:GetDownloadUrlForLayer' },
    ]);
  });

  test('waits and retries deletion while Lightsail is updating the service', async () => {
    const transition = Object.assign(
      new Error('The specified service is in a transition state ("UPDATING") and cannot be deleted.'),
      { name: 'InvalidInputException' },
    );
    const commands: string[] = [];
    let deleteAttempts = 0;
    const backend = new LightsailAppHostingBackend({
      lightsail: {
        send: async (command: { constructor: { name: string } }) => {
          commands.push(command.constructor.name);
          if (command.constructor.name === 'DeleteContainerServiceCommand') {
            deleteAttempts += 1;
            if (deleteAttempts === 1) throw transition;
          }
          return { containerServices: [] };
        },
      },
      codebuild: commandClient({}).client as never,
      ecr: commandClient({}).client as never,
      s3: commandClient({}).client as never,
      region: 'us-west-2',
      buildBucket: 'builds',
      ecrRepositoryUri: 'repo',
      codebuildProject: 'build',
      environment: 'test',
      controlSecret: 'control-secret-for-tests',
      sleep: async () => {},
    });

    await backend.stop('kortix-test-app-updating');

    expect(deleteAttempts).toBe(2);
    expect(commands).toEqual([
      'DeleteContainerServiceCommand',
      'DeleteContainerServiceCommand',
      'GetContainerServicesCommand',
    ]);
  });

  test('reconciles only old, unprotected artifacts in this environment', async () => {
    const old = new Date('2026-08-16T00:00:00.000Z');
    const lightsail = commandClient({
      GetContainerServicesCommand: {
        containerServices: [
          { containerServiceName: 'kortix-test-app-orphan', createdAt: old },
          { containerServiceName: 'kortix-test-app-protected', createdAt: old },
          { containerServiceName: 'kortix-prod-app-other', createdAt: old },
        ],
      },
      DeleteContainerServiceCommand: {},
    });
    const s3 = commandClient({
      ListObjectsV2Command: {
        Contents: [
          { Key: 'apps/test/build-contexts/orphan.tar.gz', LastModified: old },
          { Key: 'apps/test/build-contexts/protected.tar.gz', LastModified: old },
        ],
      },
      DeleteObjectCommand: {},
    });
    const ecr = commandClient({
      DescribeImagesCommand: {
        imageDetails: [
          { imageTags: ['deployment-orphan'], imagePushedAt: old },
          { imageTags: ['deployment-protected'], imagePushedAt: old },
        ],
      },
      BatchDeleteImageCommand: {},
    });
    const backend = new LightsailAppHostingBackend({
      lightsail: lightsail.client as never,
      codebuild: commandClient({}).client as never,
      ecr: ecr.client as never,
      s3: s3.client as never,
      region: 'us-west-2',
      buildBucket: 'builds',
      ecrRepositoryUri: '123.dkr.ecr.us-west-2.amazonaws.com/apps-test',
      codebuildProject: 'build',
      environment: 'test',
      controlSecret: 'control-secret-for-tests',
      sleep: async () => {},
    });

    const result = await backend.reconcileArtifacts({
      protectedDeploymentIds: new Set(['protected']),
      protectedExternalIds: new Set(['kortix-test-app-protected']),
      now: new Date('2026-08-17T12:00:00.000Z'),
      graceMs: 60 * 60_000,
      maxDeletes: 10,
    });

    expect(result).toEqual({
      contextsListed: 2,
      imagesListed: 2,
      servicesListed: 3,
      contextsDeleted: 1,
      imagesDeleted: 1,
      servicesDeleted: 1,
      errors: 0,
    });
    expect(s3.commands.find((command) => command.name === 'DeleteObjectCommand')?.input)
      .toMatchObject({ Key: 'apps/test/build-contexts/orphan.tar.gz' });
    expect(ecr.commands.find((command) => command.name === 'BatchDeleteImageCommand')?.input)
      .toMatchObject({ repositoryName: 'apps-test', imageIds: [{ imageTag: 'deployment-orphan' }] });
    expect(lightsail.commands.find((command) => command.name === 'DeleteContainerServiceCommand')?.input)
      .toEqual({ serviceName: 'kortix-test-app-orphan' });
  });

  test('continues paginated S3 and ECR listings until it finds old unprotected artifacts', async () => {
    const old = new Date('2026-08-16T00:00:00.000Z');
    const lightsail = commandClient({
      GetContainerServicesCommand: {
        containerServices: [
          { containerServiceName: 'kortix-test-app-protected', createdAt: old },
          { containerServiceName: 'kortix-test-app-orphan', createdAt: old },
        ],
      },
      DeleteContainerServiceCommand: {},
    });
    const s3 = commandClient({
      ListObjectsV2Command: [
        {
          Contents: [{ Key: 'apps/test/build-contexts/protected.tar.gz', LastModified: old }],
          IsTruncated: true,
          NextContinuationToken: 's3-page-2',
        },
        {
          Contents: [{ Key: 'apps/test/build-contexts/orphan.tar.gz', LastModified: old }],
        },
      ],
      DeleteObjectCommand: {},
    });
    const ecr = commandClient({
      DescribeImagesCommand: [
        {
          imageDetails: [{ imageTags: ['deployment-protected'], imagePushedAt: old }],
          nextToken: 'ecr-page-2',
        },
        {
          imageDetails: [{ imageTags: ['deployment-orphan'], imagePushedAt: old }],
        },
      ],
      BatchDeleteImageCommand: {},
    });
    const backend = new LightsailAppHostingBackend({
      lightsail: lightsail.client as never,
      codebuild: commandClient({}).client as never,
      ecr: ecr.client as never,
      s3: s3.client as never,
      region: 'us-west-2',
      buildBucket: 'builds',
      ecrRepositoryUri: '123.dkr.ecr.us-west-2.amazonaws.com/apps-test',
      codebuildProject: 'build',
      environment: 'test',
      controlSecret: 'control-secret-for-tests',
      sleep: async () => {},
    });

    const result = await backend.reconcileArtifacts({
      protectedDeploymentIds: new Set(['protected']),
      protectedExternalIds: new Set(['kortix-test-app-protected']),
      now: new Date('2026-08-17T12:00:00.000Z'),
      graceMs: 60 * 60_000,
      maxDeletes: 10,
    });

    expect(result).toMatchObject({
      contextsListed: 2,
      imagesListed: 2,
      servicesListed: 2,
      contextsDeleted: 1,
      imagesDeleted: 1,
      servicesDeleted: 1,
      errors: 0,
    });
    expect(s3.commands.filter((command) => command.name === 'ListObjectsV2Command')[1]?.input)
      .toMatchObject({ ContinuationToken: 's3-page-2' });
    expect(ecr.commands.filter((command) => command.name === 'DescribeImagesCommand')[1]?.input)
      .toMatchObject({ nextToken: 'ecr-page-2' });
  });
});
