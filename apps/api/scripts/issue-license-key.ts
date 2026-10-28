// Issue a self-host Kortix Enterprise license key (KORTIX_LICENSE_KEY).
// Format and checks: src/billing/services/enterprise-license.ts.
//
// The signing key is KORTIX_LICENSE_SIGNING_KEY (base64 PKCS#8 DER, Ed25519) in
// the owner-only apps/api/.env.prod. Run it with that file:
//
//   dotenvx run -f apps/api/.env.prod -- bun apps/api/scripts/issue-license-key.ts \
//     --licensee "<organization>" --expires 2027-10-31
//
// Issue a new key each term. Set `--expires` to the order's end date.

import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { licensee: { type: 'string' }, expires: { type: 'string' } },
});
const licensee = values.licensee?.trim();
const expires = values.expires ? new Date(values.expires) : null;
const secret = process.env.KORTIX_LICENSE_SIGNING_KEY;

if (!licensee || !expires || Number.isNaN(expires.getTime()) || !secret) {
  process.stderr.write(
    'usage: issue-license-key.ts --licensee "<organization>" --expires YYYY-MM-DD (needs KORTIX_LICENSE_SIGNING_KEY)\n',
  );
  process.exit(2);
}

const privateKey = createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' });
const payload = Buffer.from(JSON.stringify({ licensee, expires_at: expires.toISOString() }));
const key = `${payload.toString('base64url')}.${sign(null, payload, privateKey).toString('base64url')}`;

process.stderr.write(
  `Signed for ${licensee}, expires ${expires.toISOString()}. Public key:\n${createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })}`,
);
process.stdout.write(`${key}\n`);
