import { expect, test } from 'bun:test';
import {
  createInstance,
  getJustavpsServerTypes,
  type CreateInstanceRequest,
  type ServerType,
  type ServerTypesResponse,
} from './index';

test('retired instance exports remain import-compatible but cannot provision a sandbox', async () => {
  const request: CreateInstanceRequest = { provider: 'justavps' };
  const type: ServerType | undefined = undefined;
  const catalog: ServerTypesResponse = await getJustavpsServerTypes('hel1');

  expect(type).toBeUndefined();
  expect(catalog).toEqual({ serverTypes: [], location: 'hel1' });
  await expect(createInstance(request)).rejects.toThrow(
    'Retired instance provisioning is unavailable',
  );
});
