import { describe, expect, test } from 'bun:test';

import { resolvePresignTarget } from './project-snapshot-store';

describe('resolvePresignTarget — where the sandbox downloads from', () => {
  test('plain AWS: the API client signs, on the regional endpoint', () => {
    expect(resolvePresignTarget({ publicEndpoint: '', accelerate: false, forcePathStyle: false })).toEqual({
      endpoint: '',
      useAccelerateEndpoint: false,
      forcePathStyle: false,
      sameAsApiClient: true,
    });
  });

  test('Transfer Acceleration: a separate client on the accelerate endpoint, never path-style', () => {
    // The SDK refuses forcePathStyle together with useAccelerateEndpoint, so
    // a stray path-style flag must not leak into the presign client.
    expect(resolvePresignTarget({ publicEndpoint: '', accelerate: true, forcePathStyle: true })).toEqual({
      endpoint: '',
      useAccelerateEndpoint: true,
      forcePathStyle: false,
      sameAsApiClient: false,
    });
  });

  test('a custom public endpoint (MinIO behind a tunnel) wins over acceleration, keeps path-style', () => {
    expect(
      resolvePresignTarget({ publicEndpoint: ' https://store.example.test ', accelerate: true, forcePathStyle: true }),
    ).toEqual({
      endpoint: 'https://store.example.test',
      useAccelerateEndpoint: false,
      forcePathStyle: true,
      sameAsApiClient: false,
    });
  });
});
