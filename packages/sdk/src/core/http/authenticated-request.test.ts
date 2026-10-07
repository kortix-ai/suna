import { afterEach, expect, test } from 'bun:test';
import { authenticatedRequest } from './authenticated-request';
import { configureKortix } from './config';

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

test('authenticatedRequest returns the URL with the bearer and client version the SDK would send', async () => {
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 'tok', clientVersion: 'mobile/1.2.3' });
  const request = await authenticatedRequest('https://api.test/v1/p/ext-1/3000/index.html');
  expect(request.url).toBe('https://api.test/v1/p/ext-1/3000/index.html');
  expect(request.headers.authorization).toBe('Bearer tok');
  expect(request.headers['x-kortix-client-version']).toBe('mobile/1.2.3');
});

test('authenticatedRequest refuses a URL outside the backend origin, so the token never leaves it', async () => {
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 'tok' });
  await expect(authenticatedRequest('https://evil.example/v1/p/ext-1/3000')).rejects.toThrow(
    'outside the Kortix backend',
  );
  await expect(authenticatedRequest('http://api.test/v1/p/ext-1/3000')).rejects.toThrow('outside the Kortix backend');
});

test('authenticatedRequest rejects when the host has no token', async () => {
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => null });
  await expect(authenticatedRequest('https://api.test/v1/projects')).rejects.toBeTruthy();
});
