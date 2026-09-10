/**
 * The origin a browser reaches this API at — what the sandbox must build
 * browser-facing URLs from (the static-web `<base>` tag, OpenAPI server URLs).
 *
 * The path proxy used to take it from the request's `Host`. Behind an ingress
 * that rewrites the host that is the INTERNAL name: measured on the pi-js dev
 * stack 2026-09-10, a framed HTML file carried
 * `<base href="http://8080-01m1sj00….aec.local/v1/p/<session>/3211/abs/…">`,
 * so every relative asset of a previewed page resolved to a host no browser
 * can reach. `KORTIX_URL` is the deployment's own statement of where it is
 * public; when it names an https origin, that is the answer. A laptop
 * (`http://localhost:8008`) keeps the host the request arrived on — the
 * subdomain preview scheme depends on it.
 */
export function configuredPublicOrigin(kortixUrl: string | null | undefined): string | null {
  const raw = (kortixUrl ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The public origin for a proxied request: the configured one, else what the request said. */
export function publicOriginFor(
  kortixUrl: string | null | undefined,
  requestProto: string,
  requestHost: string,
): string {
  return configuredPublicOrigin(kortixUrl) ?? `${requestProto}://${requestHost}`;
}
