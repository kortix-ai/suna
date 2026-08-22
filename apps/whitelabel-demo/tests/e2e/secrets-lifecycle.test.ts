import type { ProjectSecret } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { pendingKeyCollision } from '../../src/lib/secret-collisions';
import {
  buildSecretRotateInput,
  buildSecretUpsertInput,
  defaultIdentifier,
  secretWriteIntent,
} from '../../src/lib/secret-upsert';

const secret = (identifier: string, name: string) =>
  ({
    identifier,
    name,
    project_id: 'P1',
    secret_id: 's1',
    created_by: null,
    created_at: null,
    updated_at: null,
    configured: true,
    mine: null,
    effective_source: 'shared',
    can_manage_shared: true,
  }) as ProjectSecret;

describe('buildSecretUpsertInput', () => {
  test('a distinct identifier is sent alongside the env KEY, not instead of it', () => {
    // The whole point of the pair is that they are separable — a body carrying
    // only one of them teaches the reader they are the same field.
    expect(
      buildSecretUpsertInput({
        identifier: 'GMAPS-backup',
        name: 'GOOGLE_MAPS_API_KEY',
        value: 'v2',
      }),
    ).toEqual({ identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY', value: 'v2' });
  });

  test('the identifier is sent explicitly even when it equals the KEY', () => {
    // The server would default it, but a request that omits it is a request
    // that cannot be read as evidence of anything.
    const input = buildSecretUpsertInput({
      identifier: 'STRIPE_KEY',
      name: 'STRIPE_KEY',
      value: 'v',
    });
    expect(input.identifier).toBe('STRIPE_KEY');
  });

  test('the KEY is upper-cased the way the server stores it', () => {
    const input = buildSecretUpsertInput({ identifier: 'gmaps', name: ' stripe_key ', value: 'v' });
    expect(input.name).toBe('STRIPE_KEY');
    // The identifier is NOT upper-cased — it is stored verbatim.
    expect(input.identifier).toBe('gmaps');
  });

  test('an untouched identifier falls back to the KEY', () => {
    const input = buildSecretUpsertInput({
      identifier: defaultIdentifier(''),
      name: 'STRIPE_KEY',
      value: 'v',
    });
    expect(input.identifier).toBe('STRIPE_KEY');
  });
});

describe('secretWriteIntent', () => {
  const items = [secret('GMAPS-primary', 'GOOGLE_MAPS_API_KEY')];

  test('a new identifier is a create', () => {
    expect(secretWriteIntent(items, { identifier: 'STRIPE', name: 'STRIPE_KEY', value: 'v' })).toEqual(
      { kind: 'create' },
    );
  });

  test('the same identifier and KEY is a rotate', () => {
    expect(
      secretWriteIntent(items, {
        identifier: 'GMAPS-primary',
        name: 'GOOGLE_MAPS_API_KEY',
        value: 'v2',
      }),
    ).toEqual({ kind: 'rotate' });
  });

  test('reusing an identifier under a different KEY is the 409 the server raises', () => {
    // Retargeting an identifier re-aims every agent grant that names it, so the
    // server refuses. Naming it here is what lets the form say so first.
    expect(
      secretWriteIntent(items, { identifier: 'GMAPS-primary', name: 'OTHER_KEY', value: 'v' }),
    ).toEqual({ kind: 'retarget', existingKey: 'GOOGLE_MAPS_API_KEY' });
  });

  test('an empty project is always a create', () => {
    expect(secretWriteIntent(undefined, { identifier: 'A', name: 'A', value: 'v' })).toEqual({
      kind: 'create',
    });
  });
});

describe('buildSecretRotateInput', () => {
  test("a rotate re-sends the row's own KEY — anything else turns it into a retarget", () => {
    expect(buildSecretRotateInput(secret('GMAPS-backup', 'GOOGLE_MAPS_API_KEY'), 'fresh')).toEqual({
      identifier: 'GMAPS-backup',
      name: 'GOOGLE_MAPS_API_KEY',
      value: 'fresh',
    });
  });
});

describe('a KEY collision is surfaced before the create, not at session create', () => {
  const items = [secret('GMAPS-primary', 'GOOGLE_MAPS_API_KEY')];

  test('a second identifier on an existing KEY names the identifier it collides with', () => {
    // Storing both is legal. Allowlisting both is 409
    // SECRET_IDENTIFIER_KEY_COLLISION, and the allowlist can never be edited —
    // so the warning has to arrive while the second secret is being typed.
    expect(
      pendingKeyCollision(items, { identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' }),
    ).toEqual(['GMAPS-primary']);
  });

  test('the KEY is compared as the server will store it', () => {
    expect(
      pendingKeyCollision(items, { identifier: 'GMAPS-backup', name: ' google_maps_api_key ' }),
    ).toEqual(['GMAPS-primary']);
  });

  test('rotating the same identifier is not a collision with itself', () => {
    expect(
      pendingKeyCollision(items, { identifier: 'GMAPS-primary', name: 'GOOGLE_MAPS_API_KEY' }),
    ).toEqual([]);
  });

  test('an unused KEY collides with nothing', () => {
    expect(pendingKeyCollision(items, { identifier: 'STRIPE', name: 'STRIPE_KEY' })).toEqual([]);
  });

  test('a half-typed row is not reported as a collision', () => {
    expect(pendingKeyCollision(items, { identifier: '', name: '' })).toEqual([]);
  });
});
