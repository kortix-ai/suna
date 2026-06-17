# tests/_support

Shared test data factories, fixtures, and mocks reused across the unit and
integration suites. These have no test-runner coupling beyond `mocks.ts`, which
imports `vi` from Vitest.

## Files

| File           | Purpose |
|----------------|---------|
| `factories.ts` | Typed factory helpers. `defineFactory` builds deterministic, sequence-numbered records; `userFactory` / `projectFactory` are examples; `buildMany` repeats a factory. |
| `fixtures.ts`  | Higher-level scenarios assembled from factories (`buildWorkspace`), static sample env, and `withEnv` for scoped `process.env` overrides. |
| `mocks.ts`     | Reusable test doubles: `fakeClock` and a `fakeKeyValueStore` built on `vi.fn()`. |

## Usage

```ts
import { userFactory, buildMany } from '../_support/factories';
import { buildWorkspace } from '../_support/fixtures';
import { fakeKeyValueStore } from '../_support/mocks';

const admin = userFactory({ isPlatformAdmin: true });
const tenUsers = buildMany(userFactory, 10);
const { admin: wsAdmin, projects } = buildWorkspace();
const store = fakeKeyValueStore({ seeded: 1 });
```

## Adding a factory

1. Declare the shape as an `interface`.
2. Build it with `defineFactory<Shape>((index) => ({ ... }))` so each call gets a
   unique, deterministic value (use `index` for human-readable fields, `randomUUID()`
   for ids).
3. Export it. Keep values deterministic — no `Date.now()`, no `Math.random()` for
   anything an assertion might read.

## Conventions

- No docstring or inline comments in `.ts` files — name things clearly instead.
- Factories never hit the network or filesystem.
- Pin shared sample values (emails on `example.test`, epoch timestamps) so tests
  stay reproducible.
