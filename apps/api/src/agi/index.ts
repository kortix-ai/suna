/**
 * AGI autonomous operations (docs/specs/2026-07-26-agi-autonomous-operations.md).
 *
 * Thin barrel: the route modules register themselves on `agiApp` as an import
 * side effect, exactly like `projects/index.ts` does for routes/rN. Adding a
 * route group here is the only wiring step — a module that compiles but is not
 * imported never mounts.
 */
import './goals/routes';
import './liveness/routes';
import './observations/routes';
import './requests/routes';
import './tasks/routes';

export { agiApp } from './app';
