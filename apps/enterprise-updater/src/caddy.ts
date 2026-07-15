/**
 * The appliance Caddy image — a FIXED appliance dependency, not per-customer
 * plumbing. Caddy terminates TLS and owns the routing table on the single box.
 *
 * This pins the official, public `caddy` image by its multi-arch OCI index digest
 * (verified from the Docker Hub registry). It is pullable on any VPS and on AWS
 * with no credentials, immutable, and from a trustworthy upstream (Docker Official
 * Images). The signed app bundle bakes THIS exact ref as the compose default and
 * the updater passes it at install time, so a missing KORTIX_CADDY_IMAGE env var
 * is never fatal — the box always has a known-good, digest-pinned Caddy.
 *
 * TLS challenge: the stock official image solves ACME HTTP-01 (port 80 is open on
 * the appliance security group and on any VPS), which is the v1 default on every
 * platform. ACME DNS-01 via Route53 needs the caddy-dns/route53 plugin, which the
 * official image does NOT bundle; the app bundle ships `caddy/Dockerfile` (xcaddy
 * build) for operators who want DNS-01 (wildcards / port-80-closed networks). An
 * operator enables it by building that image, setting KORTIX_CADDY_IMAGE to the
 * resulting digest-pinned ref, and setting KORTIX_ACME_PROVIDER=route53. The
 * instance-role Route53 grant and the Caddyfile's `import acme.caddy` seam stay
 * latent and harmless until then (see the deployment runbook). TODO(caddy-route53):
 * publish a signed, digest-pinned route53 Caddy build so DNS-01 is the default.
 *
 * caddy:2.11.4 — index digest verified against registry-1.docker.io / hub.docker.io.
 */
export const APPLIANCE_CADDY_IMAGE =
  'docker.io/library/caddy:2.11.4@sha256:af5fdcd76f2db5e4e974ee92f96ee8c0fc3edb55bd4ba5032547cbf3f65e486d';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

/** A Caddy ref is usable only when digest-pinned (…@sha256:<64 hex>). */
export function assertDigestPinnedCaddy(caddyImage: string): void {
  const at = caddyImage.lastIndexOf('@');
  if (at < 0 || !SHA256.test(caddyImage.slice(at + 1))) {
    throw new Error('KORTIX_CADDY_IMAGE must be digest-pinned (…@sha256:<64 hex>)');
  }
}
