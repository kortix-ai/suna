/**
 * The denial surface and the cheap short-circuit.
 *
 * The VERDICT itself is `filterAccessibleObjects` (iam/authorize.ts) — already
 * covered there and by the IAM contract suites — and this module is its thin
 * project-side wrapper. What is new, and what a client acts on, is the 403's
 * shape and the "no slugs ⇒ no I/O" guard that keeps an ordinary project from
 * paying for a feature it does not use. The drop/share fold those slugs feed is
 * pinned in ./session-inventory.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import { accessibleSpaceSlugs, spaceDenial } from './space-access';

describe('spaceDenial', () => {
  test('names the alternatives when the caller holds some', async () => {
    const error = spaceDenial('marketing', ['research', 'sales']);
    expect(error).toBeInstanceOf(HTTPException);
    expect(error.status).toBe(403);
    const body = await error.getResponse().json();
    expect(body).toEqual({
      error:
        "You don't have access to the marketing space — pick one of: research, sales.",
      message:
        "You don't have access to the marketing space — pick one of: research, sales.",
      code: 'space_not_accessible',
      accessible_spaces: ['research', 'sales'],
    });
  });

  test('tells a caller with none what to ask for', async () => {
    const body = await spaceDenial('marketing', []).getResponse().json();
    expect(body.code).toBe('space_not_accessible');
    expect(body.accessible_spaces).toEqual([]);
    expect(body.error).toBe(
      "You don't have access to the marketing space. Ask a manager to grant it to you.",
    );
  });

  test('the response is JSON so a client can read `code`', () => {
    expect(spaceDenial('x', []).getResponse().headers.get('content-type')).toBe(
      'application/json',
    );
  });
});

describe('accessibleSpaceSlugs', () => {
  // A project with no spaces must not build an actor or hit the grant
  // memo. Passing a null context proves it: any I/O would throw.
  test('an empty slug list answers [] without touching IAM', async () => {
    await expect(
      accessibleSpaceSlugs(null as never, null as never, 'project-1', []),
    ).resolves.toEqual([]);
  });
});
