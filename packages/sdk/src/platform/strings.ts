/**
 * Dependency-free string helpers shared across the SDK (and its hosts).
 */

/**
 * Strip trailing '/' characters in linear time. The idiomatic regex form
 * (`.replace(/\/+$/, '')`) backtracks quadratically on adversarial inputs
 * with many repeated slashes (CodeQL `js/polynomial-redos`) — URLs here come
 * from config/runtime state, but every call site sits on a hot request path,
 * so the SDK standardizes on this loop instead.
 */
export function stripTrailingSlashes(s: string): string {
	let end = s.length;
	while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
	return end === s.length ? s : s.slice(0, end);
}
