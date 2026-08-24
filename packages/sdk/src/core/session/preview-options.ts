/**
 * The ONE way to build the options a preview URL is derived from.
 *
 * `rewriteLocalhostUrl` and its siblings in `url.ts` are pure: they answer
 * "which URL" from an options bag and never touch the network. That purity is
 * worth keeping — it is why they are exhaustively testable — but it puts the
 * burden of assembling a COMPLETE bag on whoever calls them, and an incomplete
 * bag does not fail. It falls back to the path proxy, silently, forever.
 *
 * That is not hypothetical. There are two call paths — a session handle
 * (`kortix.session(...).previewUrl()`) and the ambient runtime
 * (`deriveSubdomainOpts`, which the web app's preview iframe, `useSandboxProxy`
 * and `buildStaticFilePreviewUrl` all use) — and each assembled the bag itself.
 * When `previewUrlTemplate` was added, only the first was updated, so every
 * preview in the session panel kept rendering `/v1/p/{sandbox}/{port}` however
 * loudly the deployment advertised an origin. Nothing failed; the wrong thing
 * merely kept working.
 *
 * So: one producer, and a return type whose fields are all REQUIRED. A future
 * call path that forgets a field does not compile, which is the only kind of
 * guarantee worth having for a failure mode this quiet.
 */
import { cachedPreviewUrlTemplate, hasPreviewConfig, loadPreviewUrlTemplate } from './preview-config';
import type { SubdomainUrlOptions } from './url';

/**
 * A fully-resolved options bag. Every field required — including
 * `previewUrlTemplate`, whose `null` means "this deployment serves no preview
 * domain" and is a real answer, not an omission.
 */
export interface ResolvedPreviewOptions extends SubdomainUrlOptions {
  previewUrlTemplate: string | null;
}

/**
 * Resolve preview options for a sandbox against a backend.
 *
 * Reads the deployment's answer from the `GET /v1/p/config` cache, and asks
 * again in the background when this backend has never answered — a rolling
 * deploy can serve one request from a task that predates the route, and without
 * the retry that single miss would pin the caller to the path proxy for its
 * whole life. A backend that answered "no preview domain" HAS answered and is
 * not re-asked.
 */
export function resolvePreviewOptions(input: {
  sandboxId: string;
  apiBaseUrl: string;
  backendPort: number;
}): ResolvedPreviewOptions {
  const { apiBaseUrl } = input;
  if (!hasPreviewConfig(apiBaseUrl)) void loadPreviewUrlTemplate(apiBaseUrl).catch(() => {});
  return {
    sandboxId: input.sandboxId,
    backendPort: input.backendPort,
    apiBaseUrl,
    previewUrlTemplate: cachedPreviewUrlTemplate(apiBaseUrl),
  };
}
