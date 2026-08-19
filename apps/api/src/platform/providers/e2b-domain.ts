import { config } from '../../config';

/**
 * The one E2B cluster this deployment talks to.
 *
 * Three defaults used to disagree. Kortix config defaults `E2B_DOMAIN` to
 * `e2b.dev`; the E2B SDK defaults its `domain` option to the `E2B_DOMAIN`
 * process variable or `e2b.app`; and the snapshot adapter's raw `/templates`
 * fetch derived its own base URL from the Kortix value. An operator who never
 * exported the variable therefore built templates against one cluster and
 * created sandboxes against another, and a self-hosted E2B deployment — where
 * the cluster is neither default — could not work at all. Both halves now read
 * this function and pass `domain` to the SDK explicitly.
 *
 * Accepts a value with or without a scheme or trailing slash so an operator who
 * pastes `https://e2b.acme.internal/` gets `e2b.acme.internal`.
 */
export function e2bDomain(): string {
  const domain = (config.E2B_DOMAIN ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!domain) {
    throw new Error(
      'E2B_DOMAIN is empty — set it to the E2B cluster base domain (E2B Cloud: e2b.dev).',
    );
  }
  return domain;
}
