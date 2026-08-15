import { describe, expect, test } from 'bun:test';

import { rewriteStorageOrigin } from './storage-url';

const INTERNAL = 'http://supabase-kong:8000';
const PUBLIC = 'https://essentia.kortix.cloud';
const SIGNED = `${INTERNAL}/storage/v1/object/upload/sign/app-artifacts/a/b/c?token=jwt.abc`;

describe('rewriteStorageOrigin', () => {
  test('rewrites the internal Docker host to the public origin for client-facing URLs', () => {
    expect(rewriteStorageOrigin(SIGNED, INTERNAL, PUBLIC)).toBe(
      `${PUBLIC}/storage/v1/object/upload/sign/app-artifacts/a/b/c?token=jwt.abc`,
    );
  });

  test('no-op when the public base is unset (managed cloud: SUPABASE_URL already public)', () => {
    expect(rewriteStorageOrigin(SIGNED, INTERNAL, undefined)).toBe(SIGNED);
    expect(rewriteStorageOrigin(SIGNED, INTERNAL, '')).toBe(SIGNED);
  });

  test('no-op when public equals internal', () => {
    const publicOnly = `${PUBLIC}/storage/v1/x`;
    expect(rewriteStorageOrigin(publicOnly, PUBLIC, PUBLIC)).toBe(publicOnly);
  });

  test('tolerates a trailing slash on either base', () => {
    expect(rewriteStorageOrigin(SIGNED, `${INTERNAL}/`, `${PUBLIC}/`)).toBe(
      `${PUBLIC}/storage/v1/object/upload/sign/app-artifacts/a/b/c?token=jwt.abc`,
    );
  });

  test('leaves a URL that is not on the internal host untouched', () => {
    const already = `${PUBLIC}/storage/v1/object/y`;
    expect(rewriteStorageOrigin(already, INTERNAL, PUBLIC)).toBe(already);
  });

  test('preserves a public base that carries a path prefix', () => {
    expect(rewriteStorageOrigin(SIGNED, INTERNAL, 'https://host.example/sb')).toBe(
      'https://host.example/sb/storage/v1/object/upload/sign/app-artifacts/a/b/c?token=jwt.abc',
    );
  });
});
