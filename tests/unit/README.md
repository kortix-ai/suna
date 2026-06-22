# Unit tests

Fast, isolated tests for pure logic and individual modules. No network, no
filesystem, no Docker — anything external is replaced with a test double.

Runner: [Vitest](https://vitest.dev) (OSS). Coverage via `@vitest/coverage-v8`.

## What's here

| File                    | Shows |
|-------------------------|-------|
| `example-slugify.ts`    | Module under test (pure functions). |
| `example-pure.test.ts`  | Pure-function testing, plus reuse of a shared factory. |
| `example-notifier.ts`   | Module under test with an injectable dependency. |
| `example-mock.test.ts`  | Mocking — `vi.fn()` spies for the injected dep and `vi.mock()` for a module import. |
| `vitest.config.ts`      | Node env, globals, JUnit + coverage reporters and 80% thresholds. |

## Run

```bash
cd tests

# all unit tests, JUnit -> test-results/unit/junit.xml
npx vitest run --config unit/vitest.config.ts

# with coverage gate (HTML + lcov -> test-results/unit/coverage)
npx vitest run --config unit/vitest.config.ts --coverage

# watch a single file while developing
npx vitest --config unit/vitest.config.ts unit/example-pure.test.ts
```

Coverage is `enabled: false` by default so a plain `run` stays fast; the
`--coverage` flag turns it on and enforces the 80% thresholds.

## Add a unit test

1. Create `unit/<name>.test.ts`.
2. `import { describe, expect, it, vi } from 'vitest'`.
3. Reuse data from `../_support/factories` and `../_support/fixtures`; reuse
   doubles from `../_support/mocks`.
4. Keep it hermetic. If you reach for a real service, it belongs in
   `tests/integration/` instead.
5. No docstring or inline comments — lean on clear names (repo style).
