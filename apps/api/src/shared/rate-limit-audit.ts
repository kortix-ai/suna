/**
 * The action of every rate-limit audit event. Fixed, and without the path: a
 * path segment can be a bearer capability (a setup link, an approval link),
 * and the request's own audit row already names its route. `metadata.limiter`
 * says which limiter refused the request.
 *
 * A leaf module on purpose: tests replace `shared/rate-limit` with partial
 * `mock.module` stubs, and a constant exported from there would be missing
 * under those stubs.
 */
export const RATE_LIMIT_EXCEEDED_ACTION = 'api.rate_limit.exceeded';
