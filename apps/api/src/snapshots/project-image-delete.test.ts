import { describe, expect, mock, test } from 'bun:test';
import {
  legacyPerProjectWarmImageName,
  perProjectWarmImageName,
  scopedPerProjectWarmImageName,
} from './ppwarm-names';

const deletedNames: string[] = [];
const stateReads: string[] = [];
const providerRequests: string[] = [];

mock.module('./providers', () => ({
  getSandboxProvider: (provider: string) => {
    providerRequests.push(provider);
    return {
      id: provider,
      isConfigured: () => true,
      getSnapshotState: async (snapshotName: string) => {
        stateReads.push(snapshotName);
        return 'active' as const;
      },
      deleteSnapshot: async (snapshotName: string) => {
        deletedNames.push(snapshotName);
      },
      listSnapshots: async () => [],
      buildSnapshot: async () => {},
    };
  },
}));

const { deleteProjectSandboxImage } = await import('./project-image-delete');

describe('deleteProjectSandboxImage', () => {
  test.each([
    scopedPerProjectWarmImageName(
      '123456789abc',
      '9ee8bc9c-5108-437f-a01f-6c5e26f2062c',
      'a'.repeat(40),
      'kortix-default-e881f000eae5',
      'default',
    ),
    perProjectWarmImageName(
      '9ee8bc9c-5108-437f-a01f-6c5e26f2062c',
      'a'.repeat(40),
      'kortix-default-e881f000eae5',
      'default',
    ),
    legacyPerProjectWarmImageName(
      '9ee8bc9c-5108-437f-a01f-6c5e26f2062c',
      'a'.repeat(40),
      'kortix-default-e881f000eae5',
    ),
  ])('deletes only the exact project-image name %s', async (snapshotName) => {
    deletedNames.length = 0;
    stateReads.length = 0;
    providerRequests.length = 0;

    await expect(deleteProjectSandboxImage(snapshotName, 'daytona')).resolves.toEqual({
      deleted: true,
      snapshotName,
    });

    expect(providerRequests).toEqual(['daytona']);
    expect(stateReads).toEqual([snapshotName]);
    expect(deletedNames).toEqual([snapshotName]);
  });

  test.each([
    'kortix-default-e881f000eae5',
    'kortix-tpl-custom-e881f000eae5',
    'kortix-ppwarm-9ee8bc9c-aaaaaaaaaaaa__deleted_tpl_1',
    'kortix-ppwarm-9ee8bc9c-not-hex',
  ])('rejects %s before provider lookup', async (snapshotName) => {
    deletedNames.length = 0;
    stateReads.length = 0;
    providerRequests.length = 0;

    await expect(deleteProjectSandboxImage(snapshotName, 'daytona')).rejects.toThrow(
      'Refusing to delete non-project sandbox image',
    );

    expect(providerRequests).toEqual([]);
    expect(stateReads).toEqual([]);
    expect(deletedNames).toEqual([]);
  });
});
