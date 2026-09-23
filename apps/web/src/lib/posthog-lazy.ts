/**
 * The one way app code reaches posthog-js. A static `import posthog from
 * 'posthog-js'` put the library (~60 KB gzipped) in the root layout chunk —
 * every route, every visitor — through PostHogIdentify and lib/track. The
 * module is fetched on first use instead and shared afterwards, so every call
 * still lands on the same singleton instance.
 */
type PostHog = (typeof import('posthog-js'))['default'];

let posthogModule: Promise<PostHog> | null = null;

export function loadPostHog(): Promise<PostHog> {
  posthogModule ??= import('posthog-js').then((mod) => mod.default);
  return posthogModule;
}

/** True once some caller has requested posthog-js in this page. */
export function isPostHogLoaded(): boolean {
  return posthogModule !== null;
}
