/**
 * The runner knobs a lane run reads from its environment. The hermetic
 * scrubs (package-quality's workspace env, local.ts's process env) keep
 * these and drop every other KORTIX_* variable: CI runs with none of them
 * set, while a Kortix sandbox injects its runtime identity under KORTIX_*,
 * which would make every lane test the sandbox instead of the product.
 * Documented in tests/README.md and next to the consumers named below.
 */
export const RUNNER_CONTROLS = new Set([
  // tests/bin/package-quality.ts and apps/api/scripts/test.sh
  'KORTIX_API_TEST_WORKERS',
  'KORTIX_MIN_TEST_FILES',
  'KORTIX_PACKAGE_SKIP_SDK_TESTS',
  // tests/bin/db-suites.ts
  'KORTIX_DB_SUITE_WORKERS',
  'KORTIX_DB_SUITE_TIMEOUT_MS',
  'KORTIX_DB_TEST_TIMEOUT_MS',
]);
